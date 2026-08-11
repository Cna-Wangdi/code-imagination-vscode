import { Component, EventEmitter, Input, Output, computed, effect, inject, signal } from '@angular/core';
import { map } from 'rxjs';

class DashboardService {
  save(value: number) {
    return { pipe: (..._operators: unknown[]) => ({ subscribe: (_observer: unknown) => undefined }) };
  }
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './AngularDashboard.component.html'
})
export class AngularDashboardComponent {
  @Input() title = 'Dashboard';
  @Output() saved = new EventEmitter<number>();

  private readonly dashboard = inject(DashboardService);
  count = signal(0);
  doubled = computed(() => this.count() * 2);
  logChanges = effect(() => console.log(this.count()));

  increment() {
    this.count.update((current) => current + 1);
  }

  save() {
    this.dashboard.save(this.count())
      .pipe(map((value) => value))
      .subscribe({
        next: (value) => this.saved.emit(value),
        error: (error) => console.error(error)
      });
  }
}
