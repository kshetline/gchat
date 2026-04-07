// ==UserScript==
// @name         Comchat-Mods
// @namespace    https://chatproxy.chat/
// @version      2026-04-07
// @description  Enhance Comchat functionality
// @author       Anonymous
// @license      MIT
// @match        %%HOST%%
// @icon         https://www.google.com/s2/favicons?sz=64&domain=%%ICON_DOMAIN%%
// @grant        none
// ==/UserScript==
// @ts-check

(function () {
  'use strict';

  console.log('Comchat-Mods loaded');

  // A little type-checking deception below
  const frames = document.querySelector('frame' + 'set');
  const formFrame = /** @type {HTMLIFrameElement} */ (document.querySelector('frame[name="form"]'));
  const logFrame = /** @type {HTMLIFrameElement} */ (document.querySelector('frame[name="log"]'));
  let formDoc;
  let form;
  let formSrc;
  let savedRows;
  let savedLogFrameSrc;
  let originalSound = localStorage.getItem('originalSoundEnabled') || localStorage.getItem('notificationSoundEnabled') || 'true';

  if (!frames || !formFrame || !logFrame) {
    return;
  }

  localStorage.setItem('originalSoundEnabled', originalSound);
  savedRows = frames.getAttribute('rows');
  frames.setAttribute('rows', '0,*');
  frames.setAttribute('frameborder', '0');
  frames.setAttribute('border', '0');
  frames.setAttribute('framespacing', '0');
  savedLogFrameSrc = logFrame.src;
  logFrame.src = '%%ENHANCED_CHAT_URL%%';

  const hiddenFrame = document.createElement('iframe');

  hiddenFrame.name = 'hidden_frame';
  hiddenFrame.style.display = 'none';
  document.body.appendChild(hiddenFrame);

  function revert() {
    hiddenFrame.remove();
    frames.setAttribute('rows', savedRows);
    frames.removeAttribute('frameborder');
    frames.removeAttribute('border');
    frames.removeAttribute('framespacing');
    logFrame.src = savedLogFrameSrc;

    let currentForm = document.querySelector('frame[name="entry"]');

    if (currentForm) {
      currentForm.setAttribute('target', 'form');
    }
    else if ((currentForm = document.querySelector('frame[name="send"]'))) {
      currentForm.setAttribute('target', 'log');
    }

    if (formDoc) {
      formDoc.getElementById('notificationSoundCheckbox').checked = (originalSound === 'true');
    }

    localStorage.setItem('notificationSoundEnabled', originalSound);
  }

  function extractError(body) {
    if (!body) {
      return 'Page not loaded';
    }

    const html = body.innerHTML;

    if (html && !html.includes('<(form|div)')) { // No form or div? Might be error page.
      return (/<h1>([3-5]\d\d\b.+)<\/h2>/.exec(html) || [])[1];
    }

    return null;
  }

  function documentCheck(frame, action, selector, callback = null, tries = 0) {
    const doc = frame.contentDocument;
    const formError = extractError(doc?.body);

    if (formError && formError !== 'Page not loaded') {
      logFrame.contentWindow.postMessage([action, formError], '*');
    }
    else if (doc.querySelector(selector)) {
      logFrame.contentWindow.postMessage([action, null], '*');

      if (callback) {
        callback();
      }
    }
    else if (++tries < 50) {
      setTimeout(() => documentCheck(frame, action, selector, callback, ++tries), 100);
    }
    else {
      logFrame.contentWindow.postMessage([action, 'Timed out'], '*');
    }
  }

  function enterChatRoom(name, email, color) {
    const nameField = formDoc.querySelector('input[name="name"]');
    const emailField = formDoc.querySelector('input[name="email"]');

    if (!nameField || !emailField) { // Already in chat?
      const comment = formDoc.querySelector('input[name="comment"]');

      if (comment) {
        comment.value = '';
      }

      logFrame.contentWindow.postMessage(['enterChatRoom', null], '*');
      return;
    }

    if (!formSrc) {
      formSrc = formFrame.src;
    }

    let tripCode;
    [name, tripCode] = name.split('#');

    if (tripCode) {
      localStorage.setItem('password', tripCode);
    }

    const colorButton = formDoc.querySelector(`input[type="radio"][value="${color}"]`);
    const submitButton = formDoc.querySelector('input[type="submit"]');

    form.setAttribute('target', '_self');
    nameField.value = name || '';
    emailField.value = email || '';
    colorButton?.click();
    submitButton.click();

    documentCheck(formFrame, 'enterChatRoom', 'input[name="comment"]', () => {
      formDoc = formFrame.contentDocument;
      formDoc.getElementById('notificationSoundCheckbox').checked = false;
      localStorage.setItem('notificationSoundEnabled', 'false');
      formDoc.querySelector('input[name="comment"]').value = '';
      formDoc.querySelector('#face').value = '';
    });
  }

  function leaveChatRoom() {
    const leaveButton = formDoc.querySelector('input[type="button"][value="Leave room"]') ||
      formDoc.querySelector('input[type="button"]');

    if (leaveButton) {
      form.setAttribute('target', '_self');
      leaveButton.click();
    }

    formFrame.src = formSrc;
    documentCheck(formFrame, 'leaveChatRoom', 'input[name="name"]');
  }

  function sendChatMessage(comment, color, tripCode) {
    let face = '';
    const $ = /^(.*)(\u2000(.+)\u2000)\s*$/.exec(comment);

    if ($) {
      comment = $[1];
      face = $[3];
    }

    formDoc.querySelector('select[name="color"]').value = color || 0;
    formDoc.querySelector('#face').value = face;
    formDoc.querySelector('input[name="comment"]').value = comment || '';
    formDoc.querySelector('input[name="password"]').value = tripCode || '';
    formDoc.querySelector('form').setAttribute('target', 'hidden_frame');

    hiddenFrame.contentDocument.body.innerHTML = '';
    form.submit();

    documentCheck(hiddenFrame, 'sendChatMessage', 'div[class="messageRow"]');
  }

  window.addEventListener('message', evt => {
    formDoc = formFrame.contentDocument;
    form = formDoc.querySelector('form');

    switch (evt.data[0]) {
      case 'enterChatRoom':
        enterChatRoom(evt.data[1], evt.data[2], evt.data[3]);
        break;
      case 'leaveChatRoom':
        leaveChatRoom();
        break;
      case 'sendChatMessage':
        sendChatMessage(evt.data[1], evt.data[2], evt.data[3]);
        break;
      case 'updateTitle':
        document.title = evt.data[1];
        break;
      case 'revert':
        revert();
        break;
    }
  });
})();
