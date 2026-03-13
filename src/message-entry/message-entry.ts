import { Component, EventEmitter, Input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Quill from 'quill';

const Size = Quill.import('attributors/style/size') as any;
Size.whitelist = ['0.625em', '0.8125em', '1em', '1.125em', '1.5em'];
Quill.register(Size, true);

@Component({
  selector: 'app-message-entry',
  imports: [FormsModule],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry implements OnInit {
  private quill: Quill;

  enabled = signal(true);
  message = signal('');

  @Input() color = 0;
  @Input() colors: string[] = [];
  @Output() changeColor = new EventEmitter<number>();
  @Output() newMessage = new EventEmitter<string>();

  ngOnInit(): void {
    const bindings = {
      enter: {
        key: 'Enter',
        'handler': () => this.sendMessage()
      }
    };

    this.quill = new Quill('#editor', {
      modules: {
        keyboard: { bindings },
        toolbar: '#toolbar',
      },
      theme: 'snow'
    });
  }

  updateColor(): void {
    this.changeColor.emit(this.color);
  }

  sendMessage(): void {
    console.log(this.quill.getContents());
    this.newMessage.emit(this.message() ?? '(no message)');
  }

  sendEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
  }

  reset(): void {
    this.sendEnabled(true);
    this.message.set('');
  }
}
