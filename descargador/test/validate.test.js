const test = require('node:test'); const assert = require('node:assert');
const { youtubeUrl } = require('../src/main/validate');
test('acepta enlaces de YouTube y los normaliza', () => {
  for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'])
    assert.strictEqual(youtubeUrl(u), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
test('rechaza todo lo demás', () => {
  for (const u of ['http://youtu.be/dQw4w9WgXcQ', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'file:///etc/passwd', 'https://user@youtu.be/dQw4w9WgXcQ', 'https://youtu.be/corto', '', null, 'https://www.youtube.com/playlist?list=abc'])
    assert.strictEqual(youtubeUrl(u), null);
});
