import { HttpClient } from '@angular/common/http';
import Quill from 'quill';
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

    this.httpClient.post<{ error?: string; url?: string }>(url, formData).subscribe({
      next: response => {
        quill.deleteText(range.index, placeholderUrl.length);
        quill.insertText(range.index, response.url);
        quill.setSelection(range.index + response.url.length);
        quill.enable(true);
        quill.focus();
      },
      error: (error: any) => {
        quill.enable(true);
        notify('error', 'Image upload failed: ' + (error?.error?.error || error?.message || error?.toString()));
        quill.deleteText(range.index, placeholderUrl.length);
      }
    });
  }
}
