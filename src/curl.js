// A turning leaf drawn as one continuous WebGL surface over the stage. Drawing it as CSS 3D strips left a hairline at every
// joint in WebKit, where each strip is composited as its own antialiased quad; one mesh with per-pixel light has no joints.

// The leaf's tangent angle along the sheet (s = 0 at the spine, 1 at the free edge) is theta + B·(2/3 − 2s + s²): curved most
// at the spine, straight at the free edge like a stiff cantilever, and zero on average so the chord, and the free edge, stay at theta.
const profile = s => 2 / 3 - 2 * s + s * s;
const SEGMENTS = 48;
// The surface reaches this far (px) past a page's outer edges, so the pixels along them can be partly covered: the edges are
// smoothed in the shader, which costs far less than multisampling where WebGL runs without a GPU.
const MARGIN = 2;
const RAD = Math.PI / 180;
// Where the sheet runs at arc lengths 0..length (fractions of the leaf width), sampled at SEGMENTS per leaf width.
// Past the leaf width (a page wider than the leaf) it carries on straight. Returns [x, z] pairs, z toward the viewer.
export function curve(theta, bend, length = 1) {
  const n = Math.ceil(SEGMENTS * length), step = length / n, points = [[0, 0]];
  for (let i = 0, x = 0, z = 0; i < n; i++) {
    const phi = (theta + bend * profile(Math.min(1, (i + .5) * step))) * RAD;
    x += Math.cos(phi) * step;
    z += Math.sin(phi) * step;
    points.push([x, z]);
  }
  return points;
}

// The light matches the pages beneath: darkest in the crease, easing out toward the free edge, deeper as the sheet turns
// edge-on. It is computed per pixel from the curve, so it is continuous across the whole sheet.
const vertex = `#version 300 es
in vec3 a_point; // x, z (px from the spine) and the arc length u (px)
in float a_row;
uniform vec2 u_size, u_origin, u_spine;
uniform float u_height, u_depth, u_margin;
out float v_u, v_y;
void main() {
  // CSS perspective: a point at depth z moves away from the perspective origin by d / (d − z).
  float w = (u_depth - a_point.y) / u_depth;
  float y = a_row * (u_height + 2. * u_margin) - u_margin;
  vec2 plane = u_spine + vec2(a_point.x, y);
  vec2 screen = u_origin + (plane - u_origin) / w;
  gl_Position = vec4((screen.x / u_size.x * 2. - 1.) * w, (1. - screen.y / u_size.y * 2.) * w, -a_point.y / u_depth * w, w);
  v_u = a_point.z;
  v_y = y;
}`;
const fragment = `#version 300 es
precision highp float;
in float v_u, v_y;
uniform sampler2D u_front, u_back;
uniform vec4 u_frontSize, u_backSize; // page width, height, top offset in the leaf, 1 when there is a page
uniform float u_theta, u_bend, u_width, u_crease;
out vec4 color;
// Piecewise linear, as fractions of the leaf width: the crease fall-off across a turning sheet.
float falloff(float s) {
  if (s < .14) return mix(1., .533, s / .14);
  if (s < .34) return mix(.533, .2, (s - .14) / .2);
  return mix(.2, .078, (min(s, 1.) - .34) / .66);
}
// The constant crease where a page meets the spine, as fractions of the page width (the same gradient the flat pages carry).
float fold(float t) {
  if (t < .014) return mix(1., .6, t / .014);
  if (t < .032) return mix(.6, .2, (t - .014) / .018);
  return mix(.2, 0., clamp((t - .032) / .028, 0., 1.));
}
void main() {
  bool front = gl_FrontFacing;
  vec4 size = front ? u_frontSize : u_backSize;
  // The back is mirrored: its spine edge is its right edge.
  float c = front ? v_u : size.x - v_u, r = v_y - size.z;
  // How much of this pixel the page covers, from its distance in pixels to the free edge (both sides hang from the spine)
  // and to the top and bottom.
  float coverage = clamp((size.x - v_u) / fwidth(v_u) + .5, 0., 1.) * clamp(min(r, size.y - r) / fwidth(r) + .5, 0., 1.);
  if (size.w == 0. || coverage == 0.) discard;
  vec2 uv = clamp(vec2(c / size.x, r / size.y), 0., 1.);
  vec3 page = (front ? texture(u_front, uv) : texture(u_back, uv)).rgb;
  float s = clamp(v_u / u_width, 0., 1.);
  float light = clamp(.5 * abs(sin(radians(u_theta + u_bend * (2. / 3. - 2. * s + s * s)))) * falloff(s), 0., .6);
  color = vec4(page * (1. - light) * (1. - u_crease * fold(v_u / size.x)) * coverage, coverage);
}`;

export class Curl {
  constructor(canvas) {
    this.canvas = canvas;
    this.textures = new Map();
    // A lost context (GPU reset, a backgrounded tab) is rebuilt once the browser restores it.
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.program = this.linking = null; this.textures.clear(); });
    canvas.addEventListener('webglcontextrestored', () => this.prepare());
  }
  // Create the context and compile in the background (linking blocks for tens of milliseconds), so a first turn need not wait.
  prepare() {
    const gl = this.gl ??= this.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, depth: true });
    if (!gl || gl.isContextLost() || this.program || this.linking || this.broken) return;
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = this.linking = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const poll = () => {
      if (this.linking !== program) return;
      if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) setTimeout(poll, 30);
      else this.setup();
    };
    setTimeout(poll, 30);
  }
  setup() {
    this.prepare();
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this.broken) return null;
    if (this.program) return gl;
    const program = this.linking;
    this.linking = null;
    // A driver that cannot build the program gets turns without a visible leaf, like a browser without WebGL.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('e-brosjyre: bladet kan ikke tegnes', gl.getAttachedShaders(program).map(s => gl.getShaderInfoLog(s)).join('') + gl.getProgramInfoLog(program));
      this.broken = true;
      return null;
    }
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(['size', 'origin', 'spine', 'height', 'depth', 'margin', 'front', 'back', 'frontSize', 'backSize', 'theta', 'bend', 'width', 'crease'].map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));
    gl.uniform1i(this.uniforms.front, 0);
    gl.uniform1i(this.uniforms.back, 1);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const point = gl.getAttribLocation(program, 'a_point'), row = gl.getAttribLocation(program, 'a_row');
    gl.enableVertexAttribArray(point);
    gl.enableVertexAttribArray(row);
    gl.vertexAttribPointer(point, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(row, 1, gl.FLOAT, false, 16, 12);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    // Unpainted pages are plain paper.
    this.paper = this.upload(new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1));
    this.program = program;
    // Draw once with nothing to show: some drivers only build the pipeline on a first real draw, which would stall a first turn.
    // At the surface's own size, so the first turn does not reallocate it either.
    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.draw({ width, height, origin: [0, 0], spine: [0, 0], leaf: { width: 1, height: 1 }, depth: 1, crease: 0, leaves: [{ theta: 0, bend: 0, front: { source: null, width: 0, height: 0, top: 0 }, back: null }] });
    this.clear();
    return gl;
  }
  upload(source) {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    return texture;
  }
  // Upload a painted page ahead of any turn, read back off the main thread, so a gesture never waits for it.
  async preload(source) {
    const bitmap = await createImageBitmap(source).catch(() => null);
    if (bitmap && this.program && !this.gl.isContextLost() && !this.textures.has(source)) this.textures.set(source, this.upload(bitmap));
    bitmap?.close();
  }
  // Each painted page is uploaded once, from its finished canvas, and kept for as long as the page itself is kept.
  texture(face) {
    if (!face.source) return this.paper;
    let texture = this.textures.get(face.source);
    if (!texture) this.textures.set(face.source, texture = this.upload(face.source));
    return texture;
  }
  // Leave the surface empty. It stays in place between turns: showing it again would rebuild its layer, stalling the next turn.
  clear() {
    if (this.empty || !this.program || this.gl.isContextLost()) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.empty = true;
  }
  // Let go of the textures of pages no longer kept (`pages` are the page canvases still kept).
  keep(pages) {
    if (!this.gl) return;
    for (const [source, texture] of this.textures) if (!pages.includes(source)) { this.gl.deleteTexture(texture); this.textures.delete(source); }
  }
  // Draw the leaves in order, later ones on top. `scene` is in stage pixels: the perspective origin, the top of the spine,
  // the leaf's width and height, the crease strength, and per leaf its angle, bend and the page on each side (or none).
  draw({ width, height, origin, spine, leaf, depth, crease, leaves }) {
    const gl = this.setup();
    if (!gl) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(width * ratio), h = Math.round(height * ratio);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.empty = false;
    const u = this.uniforms;
    gl.uniform2f(u.size, width, height);
    gl.uniform2f(u.origin, ...origin);
    gl.uniform2f(u.spine, ...spine);
    gl.uniform1f(u.height, leaf.height);
    gl.uniform1f(u.depth, depth);
    gl.uniform1f(u.width, leaf.width);
    gl.uniform1f(u.crease, crease);
    gl.uniform1f(u.margin, MARGIN);
    for (const { theta, bend, front, back } of leaves) {
      if (!front && !back) continue;
      const length = Math.max(1, ...[front, back].map(face => (face ? face.width / leaf.width : 0))) + MARGIN / leaf.width;
      const points = curve(theta, bend, length), data = new Float32Array(points.length * 8);
      points.forEach(([x, z], i) => data.set([x * leaf.width, z * leaf.width, i / (points.length - 1) * length * leaf.width, 0, x * leaf.width, z * leaf.width, i / (points.length - 1) * length * leaf.width, 1], i * 8));
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      for (const [unit, face, sizeUniform] of [[0, front, u.frontSize], [1, back, u.backSize]]) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, face ? this.texture(face) : this.paper);
        gl.uniform4f(sizeUniform, face?.width ?? 0, face?.height ?? 0, face?.top ?? 0, face ? 1 : 0);
      }
      gl.uniform1f(u.theta, theta);
      gl.uniform1f(u.bend, bend);
      gl.clear(gl.DEPTH_BUFFER_BIT); // A leaf can hide parts of itself, never the one drawn after it.
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, points.length * 2);
    }
  }
}
