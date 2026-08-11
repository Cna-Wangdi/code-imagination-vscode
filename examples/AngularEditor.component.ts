import { Component, ElementRef, ViewChild, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { FormControl, FormGroup } from '@angular/forms';
import { catchError, of, switchMap, tap } from 'rxjs';

@Component({
  selector: 'app-editor',
  templateUrl: './AngularEditor.component.html'
})
export class AngularEditorComponent {
  @ViewChild('nameField') nameField?: ElementRef<HTMLInputElement>;

  visible = signal(true);
  items = signal<string[]>([]);
  form = new FormGroup({ name: new FormControl('') });

  constructor(private router: Router, private http: HttpClient) {}

  ngOnInit() {
    this.form.patchValue({ name: 'Ready' });
  }

  save() {
    this.http.post('/api/items', this.form.value, { headers: { 'X-Preview': 'true' } })
      .pipe(
        tap(() => console.log('saving')),
        switchMap(() => this.http.get<string[]>('/api/items')),
        catchError(() => of([]))
      )
      .subscribe((items) => this.items.set(items));
  }

  goHome() {
    this.router.navigate(['/home']);
  }
}
