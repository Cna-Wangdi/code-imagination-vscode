import { useState } from 'react';
import { nextCount } from './counterMath';

export function Counter() {
  const [count, setCount] = useState(0);

  function increment() {
    if (count < 10) {
      setCount(nextCount(count));
    }
  }

  return <button onClick={increment}>Count: {count}</button>;
}
