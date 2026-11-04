import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { inflateSync } from 'node:zlib';

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(check: () => Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

export type Pixel = [number, number, number];

function firstPixel(base64: string): Pixel {
  const png = Buffer.from(base64, 'base64');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return [raw[1]!, raw[2]!, raw[3]!];
}

export class Page {
  private readonly chrome: Chrome;
  private readonly sessionId: string;
  readonly targetId: string;

  constructor(chrome: Chrome, targetId: string, sessionId: string) {
    this.chrome = chrome;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method: string, params: object = {}) {
    return this.chrome.send(method, params, this.sessionId);
  }

  async waitForLoad(timeoutMs = 5000) {
    await until(() => this.evaluate(`document.readyState === 'complete'`), 'the page to load', timeoutMs);
  }

  async goto(url: string) {
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
    await sleep(100);
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  }

  async pixel(x: number, y: number): Promise<Pixel> {
    await this.send('Page.bringToFront');
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width: 1, height: 1, scale: 1 },
    });
    return firstPixel(data);
  }
}

export class Chrome {
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, (message: any) => void>();
  private readonly process: ChildProcess;
  private readonly profile: string;

  private constructor(process: ChildProcess, profile: string) {
    this.process = process;
    this.profile = profile;
    (process.stdio[4] as Readable).on('data', (data: Buffer) => this.receive(data));
  }

  static async launch(): Promise<Chrome> {
    const profile = mkdtempSync(join(tmpdir(), 'dusk-chrome-'));
    const args = [
      '--headless=new',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];
    const process = spawn(CHROME_PATH, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    return new Chrome(process, profile);
  }

  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (let end = this.buffer.indexOf(0); end !== -1; end = this.buffer.indexOf(0)) {
      const message = JSON.parse(this.buffer.toString('utf8', 0, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    }
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply from Chrome`));
      }, 8000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      (this.process.stdio[3] as Writable).write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  async attach(targetId: string): Promise<Page> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Page(this, targetId, sessionId);
  }

  async newPage(url: string): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const page = await this.attach(targetId);
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await page.goto(url);
    return page;
  }

  // Page and tab targets aren't linked, so a unique URL is what connects them.
  async tabTargetId(page: Page): Promise<string> {
    const marker = `#tab-${randomUUID()}`;
    await page.evaluate(`history.replaceState(null, '', ${JSON.stringify(marker)})`);
    const href = await page.evaluate<string>('location.href');
    const tab = await until(async () => {
      const { targetInfos } = await this.send('Target.getTargets', { filter: [{ type: 'tab' }] });
      return targetInfos.find((info: any) => info.url === href);
    }, `the tab for ${href}`);
    return tab.targetId;
  }

  async worker(extensionId: string): Promise<Page> {
    const prefix = `chrome-extension://${extensionId}/`;
    const target = await until(async () => {
      const { targetInfos } = await this.send('Target.getTargets');
      return targetInfos.find((info: any) => info.type === 'service_worker' && info.url.startsWith(prefix));
    }, 'the service worker');
    return this.attach(target.targetId);
  }

  async close() {
    this.process.kill();
    await sleep(800);
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
