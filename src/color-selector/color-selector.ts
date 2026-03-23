import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { colorByIndex } from '../main';
import { colors } from '../../server/src/shared-types';

let nextIDN = 0;

@Component({
  selector: 'chat-color-selector',
  imports: [FormsModule],
  templateUrl: './color-selector.html',
  styleUrl: './color-selector.scss',
})
export class ColorSelector {
  protected colorByIndex = colorByIndex;
  protected colors = colors;
  protected idn = ++nextIDN;

  darkMode = input.required<boolean>();

  color = model<number>(0);
}
