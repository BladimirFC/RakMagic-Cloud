'use strict';
const decoder = new TextDecoder('windows-1252');
const reverse = new Map();
for (let i=0; i<256; i++) reverse.set(decoder.decode(Uint8Array.of(i)), i);
function encode(text) { return Buffer.from(Array.from(String(text), c => reverse.get(c) ?? 63)); }
function wire(text) { const bytes=encode(text); return bytes.length ? bytes.toString('base64') : '-'; }
module.exports = { encode, wire, decoder };
