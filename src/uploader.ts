import { HttpClient } from '@angular/common/http';
import { notify } from './main';
import { FileUploadEvent } from './message-entry/message-entry';

export class Uploader {
  constructor(private httpClient: HttpClient) {}

  async upload(evt: FileUploadEvent, name: string, tripCode: string): Promise<void> {
    const quill = evt.quill;
    const formData = new FormData();
    const range = quill.getSelection(true);
    const placeholderUrl = '🔗';
    const url = '/api/upload' + (evt.external ? '?external=true' : '');

    formData.append('image', evt.file);
    formData.append('name', name);
    formData.append('password', tripCode);
    quill.enable(false);
    quill.insertText(range.index, placeholderUrl);

    if (evt.started)
      evt.started();

    const cleanup = (insertUrl?: string) => {
      quill.deleteText(range.index, placeholderUrl.length);

      if (insertUrl) {
        quill.insertText(range.index, insertUrl);
        quill.setSelection(range.index + insertUrl.length);
        quill.focus();
      }

      quill.enable(true);
      evt.interrupt = undefined;

      if (evt.finished)
        evt.finished();
    };

    const subscription = this.httpClient.post<{ error?: string; url?: string }>(url, formData).subscribe({
      next: response => cleanup(response.url),
      error: (error: any) => {
        if (error?.name === 'AbortError' || subscription?.closed)
          return; // canceled by user
        notify('error', 'Image upload failed: ' + (error?.error?.error || error?.message || error?.toString()));
        cleanup();
      }
    });

    evt.interrupt = () => {
      subscription.unsubscribe();
      cleanup();
    };
  }
}
