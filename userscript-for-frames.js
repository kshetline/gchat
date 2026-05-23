// ==UserScript==
// @name         Comchat-Mods
// @namespace    %%ORIGINAL_SITE_URL%%
// @version      v2026.05.22
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
  let enterFormSrc;
  let username;
  let commentFormSource;
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
    else if (++tries < 60) {
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

    if (!enterFormSrc) {
      enterFormSrc = formFrame.src;
      commentFormSource = enterFormSrc.replace(/\bmode=form\b/, 'mode=into');
    }

    let tripCode;
    [name, tripCode] = name.split('#');
    username = name;

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
    logFrame.contentWindow.focus();

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
      form.setAttribute('target', 'hidden_frame');
      leaveButton.click();
    }

    setTimeout(() => formFrame.src = enterFormSrc, 500);
    setTimeout(() => hiddenFrame.src = 'about:blank', 2000);
    documentCheck(formFrame, 'leaveChatRoom', 'input[name="name"]');
  }

  function sendChatMessage(comment, color, tripCode, retry = 0) {
    const commentField = formDoc.querySelector('input[name="comment"]');

    // This shouldn't happen, but sometimes the form disappears.
    if (!commentField) {
      if (retry > 8)
        logFrame.contentWindow.postMessage(['sendChatMessage', 'Timed out'], '*');
      else {
        if (retry === 0)
          formFrame.src = commentFormSource;

        setTimeout(() => sendChatMessage(comment, color, tripCode, ++retry), 1000);
      }

      return;
    }
    else if (retry > 0) {
      // Name has to be stored back into the refreshed comment form.
      formDoc.querySelector('input[type=hidden][name=name]').value = username;
      formDoc.querySelector('div.chatFormSection > span:nth-child(2)').innerText = username;
    }

    let face = '';
    const $ = /^(.+)(\[kao](.+)\[\/kao])\s*$/.exec(comment);

    if ($) {
      comment = $[1];
      face = $[3];
    }

    formDoc.querySelector('select[name="color"]').value = color || 0;
    formDoc.querySelector('#face').value = face;
    commentField.value = comment || '';
    formDoc.querySelector('input[name="password"]').value = tripCode || '';
    formDoc.querySelector('form').setAttribute('target', 'hidden_frame');

    if (hiddenFrame?.contentDocument?.body) {
      hiddenFrame.contentDocument.body.innerHTML = '';
    }

    form.submit();
    logFrame.contentWindow.focus();
    setTimeout(() => commentField.value = '', 100);

    documentCheck(hiddenFrame, 'sendChatMessage', 'div[class="messageRow"]');
  }

  // Check in on what's up in the hidden OG frame -- or hide it again
  function peek() {
    if (frames.getAttribute('rows').startsWith('0,')) {
      frames.setAttribute('rows', savedRows);
    }
    else {
      frames.setAttribute('rows', '0,*');
    }
  }

  window.addEventListener('message', evt => {
    const action = evt.data[0];

    if (logFrame?.contentWindow && action) {
      logFrame.contentWindow.postMessage(['ack:' + action], '*');
    }

    formDoc = formFrame.contentDocument;
    form = formDoc.querySelector('form');

    try {
      switch (action) {
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
        case 'peek':
          peek();
          break;
      }
    }
    catch (error) {
      console.error('Error handling %s:', evt.data[0], error);
      logFrame.contentWindow.postMessage([evt.data[0], error.message || String(error)], '*');
    }
  });
})();
