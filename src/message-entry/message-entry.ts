import { Component, EventEmitter, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-message-entry',
  imports: [FormsModule],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry {
  enabled = signal(true);
  message = signal('');

  @Output() newMessage = new EventEmitter<string>();

  sendMessage(): void {
    this.newMessage.emit(this.message());
  }

  sendEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
  }

  reset(): void {
    this.sendEnabled(true);
    this.message.set('');
  }
}
