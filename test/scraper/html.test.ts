import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, htmlToPlainText } from '../../src/scraper/html.js';

describe('htmlToPlainText', () => {
  test('keeps line breaks and drops formatting tags', () => {
    assert.equal(
      htmlToPlainText('<strong><span class="large">第一行</span></strong><br />第二行'),
      '第一行\n第二行',
    );
  });

  test('marks LIHKG emoticons and attachments', () => {
    assert.equal(
      htmlToPlainText('加油<img src="/assets/faces/horse/rope.gif" class="hkgmoji" />'),
      '加油[表情]',
    );
    assert.equal(
      htmlToPlainText('<img src="https://na.cx/i/example.jpg" />'),
      '[圖片]',
    );
  });

  test('decodes entities', () => {
    assert.equal(htmlToPlainText('&amp; &lt; &gt; &quot; &#39;'), '& < > " \'');
  });

  test('collapses blank lines', () => {
    assert.equal(htmlToPlainText('a<br /><br /><br />b'), 'a\n\nb');
  });
});

describe('detectLang', () => {
  test('detects Chinese versus English bodies', () => {
    assert.equal(detectLang('美股討論'), 'zh-HK');
    assert.equal(detectLang('hello world'), 'en');
  });
});
