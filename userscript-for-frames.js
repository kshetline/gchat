// ==UserScript==
// @name         Comchat-Mods
// @namespace    http://tampermonkey.net/
// @version      2026-03-28
// @description  Enhance Comchat functionality
// @author       Anonymous
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

  if (!frames || !formFrame || !logFrame)
    return;

  frames.setAttribute('rows', '0,*');
  frames.setAttribute('frameborder', '0');
  frames.setAttribute('border', '0');
  frames.setAttribute('framespacing', '0');
  logFrame.src = '%%ENHANCED_CHAT_URL%%';

  const iframe = document.createElement('iframe');

  iframe.name = 'hidden_frame';
  iframe.style.display = 'none';
  document.body.appendChild(iframe);

  function extractError(body) {
    if (!body)
      return 'Page not loaded';

    const html = body.innerHTML;

    if (!html.includes('<form')) // No form? Probably an error page.
      return (/<h1>([3-5]\d\d\b.+)<\/h2>/.exec(html) || [])[1] || 'Unknown error';

    return null;
  }

  function formCheck(action, selector, tries = 0) {
    formDoc = formFrame.contentDocument;
    form = formDoc.querySelector('form');

    const formError = extractError(formDoc.body);

    if (formError)
      logFrame.contentWindow.postMessage([action, formError], '*');
    else if (formDoc.querySelector(selector))
      logFrame.contentWindow.postMessage([action, null], '*');
    else if (++tries < 30)
      setTimeout(() => formCheck(action, selector, ++tries), 100);
    else
      logFrame.contentWindow.postMessage([action, 'Timed out'], '*');
  }

  function enterChatRoom(name, email, color) {
    const nameField = formDoc.querySelector('input[name="name"]');
    const emailField = formDoc.querySelector('input[name="email"]');

    if (!nameField || !emailField) { // Already in chat?
      logFrame.contentWindow.postMessage(['enterChatRoom', null], '*');
      return;
    }

    if (!formSrc)
      formSrc = formFrame.src;

    let tripCode;
    [name, tripCode] = name.split('#');

    if (tripCode)
      localStorage.setItem('password', tripCode);

    const colorButton = formDoc.querySelector(`input[type="radio"][value="${color}"]`);
    const submitButton = formDoc.querySelector('input[type="submit"]');

    form.setAttribute('target', '_self');
    nameField.value = name;
    emailField.value = email || '';
    colorButton?.click();
    submitButton.click();

    formCheck('enterChatRoom', 'input[name="comment"]');
  }

  function leaveChatRoom() {
    const leaveButton = formDoc.querySelector('input[type="button"][value="Leave room"]') ||
      formDoc.querySelector('input[type="button"]');

    if (leaveButton) {
      form.setAttribute('target', '_self');
      leaveButton.click();
    }

    formFrame.src = formSrc;
    formCheck('leaveChatRoom', 'input[name="name"]');
  }

  const messageSubmitter = evt => {
    evt.preventDefault();

    const formData = new FormData(form);

    fetch(form.action, {
      method: form.method,
      body: formData,
    })
      .then(response => {
        if (response.ok) {
          formDoc.querySelector('input[name="comment"]').value = '';
          logFrame.contentWindow.postMessage(['sendChatMessage', null], '*');
        }
        else
          logFrame.contentWindow.postMessage(['sendChatMessage', `Sending message failed with status ${response.status}`], '*');
      })
      .catch(error => {
        logFrame.contentWindow.postMessage(['sendChatMessage', `Sending message failed with error: ${error.message || error.toString()}`], '*');
      });
  };

  function sendChatMessage(comment, color, tripCode) {
    let face = '';
    const $ = /^(.*)(\u2000(.+)\u2000)\s*$/.exec(comment);

    if ($) {
      comment = $[1];
      face = $[3];
    }

    formDoc.querySelector('select[name="color"]').value = color;
    formDoc.querySelector('#face').value = face;
    formDoc.querySelector('input[name="comment"]').value = comment;
    formDoc.querySelector('input[name="password"]').value = tripCode;
    formDoc.querySelector('form').setAttribute('target', 'hidden_frame');

    form.setAttribute('onsubmit', null);
    form.removeEventListener('submit', messageSubmitter); // Make sure we don't double-submit
    form.addEventListener('submit', messageSubmitter);
    form.requestSubmit();
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
    }
  });
})();
