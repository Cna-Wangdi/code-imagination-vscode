import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: `
    <button (click)="increment()">Count: {{ count() }}</button>
    <button (click)="reset()">Reset</button>
  `
})
export class AngularCounter {
  count = signal(0);

  increment() {
    if (this.count() < 10) {
      this.count.update((current) => current + 1);
    }
  }

  reset() {
    this.count.set(0);
  }
}
