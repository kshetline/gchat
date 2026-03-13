import { Component, EventEmitter, Input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Quill from 'quill';
import { forEach } from '@tubular/util';

const Size = Quill.import('attributors/style/size') as any;
const sizeMap : Record<string, string>= { '0.625em': 's1', '0.8125em': 's2', '1em': 's3', '1.125em': 's4', '1.5em': 's5' };

Size.whitelist = Object.keys(sizeMap);
Quill.register(Size, true);

const tagMap: Record<string, string> = { 'bold': 'b', 'italic': 'i', 'size': '', 'strike': 's', 'underline': 'u' };
const recognizedAttributes = new Set(Object.keys(tagMap));

function quillOpsToBBCode(ops: any[]): string {
  let result = '';
  const stacks = new Map<string, any[]>();

  recognizedAttributes.forEach(attr => stacks.set(attr, []));

  for (const op of ops) {
    const attrs = new Set<string>();

    forEach(op.attributes, (key, value) => {
      if (recognizedAttributes.has(key)) {
        const stack = stacks.get(key);

        attrs.add(key);

        if (stack.at(-1) !== value) {
          stack.push(value);

          if (key === 'size')
            result += `[${sizeMap[value as string]}]`;
          else
            result += `[${tagMap[key]}]`;
        }
      }
    });

    result += op.insert.replace(/[\n\r]/g, '').replace(/\[/g, '[\u200B');

    recognizedAttributes.forEach(attr => {
      const stack = stacks.get(attr);

      if (stack.length > 0 && !attrs.has(attr)) {
        if (attr === 'size')
          result += `[/${sizeMap[stack.at(-1)]}]`;
        else
          result += `[/${tagMap[attr]}]`;

        stack.pop();
      }
    });
  }

  return result.trimEnd();
}

@Component({
  selector: 'app-message-entry',
  imports: [FormsModule],
  templateUrl: './message-entry.html',
  styleUrl: './message-entry.scss',
})
export class MessageEntry implements OnInit {
  private quill: Quill;

  enabled = signal(true);

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
    const message = quillOpsToBBCode(this.quill.getContents().ops);

    this.newMessage.emit(message);
  }

  sendEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
  }

  reset(): void {
    this.sendEnabled(true);
    this.quill.setText('');
  }
}
