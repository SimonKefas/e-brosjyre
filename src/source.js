import { PDFDataRangeTransport } from 'pdfjs-dist';

// The PDF's bytes, fetched by the viewer and handed to PDF.js.
//
// PDF.js fetches by itself only uses byte ranges when it can read `Accept-Ranges: bytes`, and a browser hides that header from
// another origin unless the host exposes it, which Webflow's asset CDN does not. Then PDF.js downloads the whole file before
// page 1. So the first request asks for `Range: bytes=0-`: a `206` answer proves the host serves ranges, and its Content-Length
// (always readable) is the file's size. The answer streams the whole file from the start, as PDF.js would, while the parts PDF.js
// needs first (the index at the end, the first pages) are fetched as ranges alongside. A `200` answer is a host without ranges:
// the same stream carries the whole file and no ranges are asked for.
//
// A browser sends `Accept-Encoding: identity` with any Range request (Fetch standard), so byte offsets are those of the file.
// Owning the requests also means the viewer sees what went wrong (a status, a cut connection) and how many bytes have arrived.
export class Source extends PDFDataRangeTransport {
  // `report` hears of every change: bytes in, a request started or settled, a failure (as `error`).
  constructor(url, report) {
    super(0, null);
    this.url = url;
    this.report = report;
    this.controller = new AbortController();
    this.loaded = 0;
    this.pending = 0; // Range requests in flight.
    this.streaming = true;
    this.error = null;
    // Rejects with the failure that ends the download, so whatever waits on the document can give way.
    this.failed = new Promise((_, reject) => { this.reject = reject; });
    this.failed.catch(() => {});
  }
  // Ask for the file; resolves once the host has answered with headers, so `length` and `ranges` are known.
  // A host that ignores the `identity` that comes with a Range request and compresses anyway gets a refusal from Chromium, so a
  // first request that fails is made once more as a plain one, as PDF.js would make it.
  async open() {
    const response = await this.fetch('bytes=0-').catch(error => {
      if (this.controller.signal.aborted) throw error;
      return this.fetch();
    });
    if (response.status !== 200 && response.status !== 206) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    this.length = Number(response.headers.get('Content-Length')) || 0;
    this.ranges = response.status === 206 && this.length > 0;
    this.stream(response.body.getReader());
    return this;
  }
  get busy() { return this.streaming || this.pending > 0; }
  fetch(range) { return fetch(this.url, { headers: range ? { Range: range } : {}, signal: this.controller.signal }); }
  async stream(reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.loaded = this.ranges ? Math.min(this.loaded + value.byteLength, this.length) : this.loaded + value.byteLength;
        this.onDataProgressiveRead(value);
        this.report();
      }
      this.streaming = false;
      this.onDataProgressiveDone();
      this.report();
    } catch (error) {
      // With ranges the stream was only a head start: PDF.js fetches whatever it still needs as ranges.
      if (this.ranges && !this.controller.signal.aborted) { this.streaming = false; this.report(); return; }
      this.fail(error);
    }
  }
  // PDF.js asks for [begin, end). Anything but exactly those bytes means the host does not serve ranges after all. PDF.js has no
  // way to hear that a range failed and would wait for it for ever, so a failed range is tried again before the download fails.
  async requestDataRange(begin, end) {
    this.pending++;
    this.report();
    for (const pause of [1000, 3000, null]) {
      try {
        const response = await this.fetch(`bytes=${begin}-${end - 1}`);
        if (response.status !== 206 || Number(response.headers.get('Content-Length')) !== end - begin) throw Object.assign(new Error('range'), { status: response.status });
        const data = await response.arrayBuffer();
        this.loaded = Math.min(this.loaded + data.byteLength, this.length);
        this.pending--;
        this.onDataRange(begin, data);
        this.report();
        return;
      } catch (error) {
        if (pause === null || this.controller.signal.aborted || (error.status && error.status !== 206)) return this.fail(error);
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    }
  }
  // The host has answered, so whatever goes wrong now is the connection (or a status), never CORS.
  fail(error) {
    if (this.controller.signal.aborted || this.error) return;
    this.error = Object.assign(error, { answered: true });
    this.abort();
    this.reject(error);
    this.report();
  }
  abort() { this.controller.abort(); }
}
