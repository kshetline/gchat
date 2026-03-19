import { HttpClient } from '@angular/common/http';
import Quill from 'quill';

export class Uploader {
  constructor(private httpClient: HttpClient) {}

  async upload(file: File, quill: Quill, tripCode: string): Promise<void> {
    const formData = new FormData();
    const range = quill.getSelection(true);
    const placeholderUrl = '🖼️';

    formData.append('image', file);
    formData.append('password', tripCode);
    quill.enable(false);
    quill.insertText(range.index, placeholderUrl);

    this.httpClient.post<{ url: string }>('/api/upload', formData).subscribe({
      next: (response) => {
        quill.deleteText(range.index, placeholderUrl.length);
        quill.insertText(range.index, response.url);
        quill.setSelection(range.index + response.url.length);
        quill.enable(true);
      },
      error: (error) => {
        quill.enable(true);
        console.error('Image upload failed:', error);
        quill.deleteText(range.index, 1);
      }
    });
  }
}
