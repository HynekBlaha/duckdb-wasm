import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync(process.argv[2] ?? new URL('../../../lib/src/http_wasm.cc', import.meta.url), 'utf8');
const blocks = [...source.matchAll(/EM_ASM_PTR\(\s*\{([\s\S]*?)\n\s*\},\s*\n\s*path\.c_str\(\)/g)].map(m => m[1]);
assert.equal(blocks.length, 5, 'Expected GET, HEAD, POST, PUT and DELETE transports');

for (const [index, method] of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].entries()) {
    test(`${method} copies HTTP bytes after another thread grows shared memory`, async () => {
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
        const staleView = new Uint8Array(memory.buffer);
        const signal = new Int32Array(new SharedArrayBuffer(4));
        const grower = new Worker(
            `
      const {parentPort} = require('node:worker_threads');
      parentPort.once('message', ({memory, signal}) => {
        memory.grow(1);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      });
    `,
            { eval: true },
        );
        const response = new TextEncoder().encode('"test"');
        const allocations = [70000, 80000];
        const context = {
            Module: { HEAPU8: staleView },
            UTF8ToString: x => String(x),
            _malloc: () => allocations.shift(),
            XMLHttpRequest: class {
                status = 200;
                response = response.buffer;
                open() {}
                setRequestHeader() {}
                getAllResponseHeaders() {
                    return 'etag: "test"\r\n';
                }
                getResponseHeader() {
                    return '"test"';
                }
                send() {
                    grower.postMessage({ memory, signal });
                    assert.notEqual(Atomics.wait(signal, 0, 0, 5000), 'timed-out');
                    assert.equal(staleView.byteLength, 65536);
                    assert.equal(memory.buffer.byteLength, 131072);
                }
            },
            console,
        };
        // Model Emscripten's canonical HEAPU8 accessor transformation. Module.HEAPU8
        // remains the old exported view, as it does on the affected pthread.
        Object.defineProperty(context, 'HEAPU8', { get: () => new Uint8Array(memory.buffer) });
        try {
            const call = vm.runInNewContext(`(function($0,$1,$2,$3,$4,$5){${blocks[index]}\n})`, context);
            const pointer = call('https://acc.dfs.core.windows.net/test.avro', 0, 0, method, 0, 0);
            assert.equal(pointer, 70000);
            const heap = new Uint8Array(memory.buffer);
            assert.deepEqual([...heap.subarray(pointer + 8, pointer + 8 + response.length)], [...response]);
            assert.equal(new DataView(memory.buffer).getUint32(pointer + 4, true), response.length);
        } finally {
            await grower.terminate();
        }
    });
}
