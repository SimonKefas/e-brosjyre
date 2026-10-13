const $ = selector => document.querySelector(selector);
const viewer = $('e-brosjyre');
$('.source-toggle').addEventListener('click', () => {
  const open = $('#source-panel').hidden;
  $('#source-panel').hidden = !open;
  $('.source-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#pdf-url').focus();
});
function validateURL(input) {
  input.setCustomValidity('');
  try {
    const url = new URL(input.value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url;
  } catch { input.setCustomValidity('Bruk en fullstendig http- eller https-lenke.'); input.reportValidity(); }
}
for (const input of document.querySelectorAll('input[type="url"]')) input.addEventListener('input', () => input.setCustomValidity(''));
// Local sample files: a choice shows only when its file is actually hosted next to the page.
const choices = [...document.querySelectorAll('.source-choices button')];
const choose = button => {
  viewer.setAttribute('src', button.dataset.src);
  viewer.setAttribute('title', button.dataset.title);
  $('#document-title').innerHTML = `${button.dataset.title}<span>.</span>`;
  $('#caption').innerHTML = button.dataset.caption;
  $('#embed-pdf').value = new URL(button.dataset.src, location.href).href;
  for (const other of choices) other.setAttribute('aria-pressed', String(other === button));
};
for (const button of choices) {
  button.addEventListener('click', () => choose(button));
  if (button.hidden) fetch(button.dataset.src, { method: 'HEAD' }).then(r => { button.hidden = !r.ok; }, () => {});
}
choices[0].setAttribute('aria-pressed', 'true');
$('#source-panel').addEventListener('submit', e => {
  e.preventDefault();
  const url = validateURL($('#pdf-url'));
  if (!url) return;
  viewer.setAttribute('src', url.href);
  viewer.setAttribute('title', 'Din brosjyre');
  $('#document-title').textContent = 'Din brosjyre.';
  $('#caption').textContent = 'PDF FRA ' + url.hostname;
  $('#embed-pdf').value = url.href;
  for (const button of choices) button.setAttribute('aria-pressed', 'false');
});
// Escape attribute values so URLs containing quotes cannot alter the generated markup.
const attribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Frame around the viewer: the demo shows the choice live and carries it into the embed code.
const chromes = [...document.querySelectorAll('.chrome-choices button')];
const frame = value => {
  viewer.setAttribute('chrome', value);
  $('#embed-chrome').value = value;
  for (const button of chromes) button.setAttribute('aria-pressed', String(button.dataset.chrome === value));
};
for (const button of chromes) button.addEventListener('click', () => frame(button.dataset.chrome));
$('#embed-chrome').addEventListener('change', e => frame(e.target.value));
$('#embed-form').addEventListener('submit', e => {
  e.preventDefault();
  const script = validateURL($('#script-url')), pdf = validateURL($('#embed-pdf'));
  if (!script || !pdf) return;
  $('#embed-code').value = `<script type="module" src="${attribute(script.href)}"></script>\n<!-- spread: "always" = to og to sider, også på mobil. "auto" = én side på smale skjermer. "single" = alltid én side. -->\n<!-- chrome: "full" = mørk boks med verktøylinje. "minimal" = gjennomsiktig, med knapper. "none" = bare boken. -->\n<e-brosjyre\n  src="${attribute(pdf.href)}"\n  title="Brosjyre"\n  spread="${attribute($('#embed-spread').value)}"\n  chrome="${attribute($('#embed-chrome').value)}"\n></e-brosjyre>`;
  $('#embed-result').hidden = false;
  $('#copy-status').textContent = '';
});
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#embed-code').value); $('#copy-status').textContent = 'Koden er kopiert.'; }
  catch { $('#embed-code').select(); $('#copy-status').textContent = 'Marker koden og kopier med Ctrl+C eller Cmd+C.'; }
});
