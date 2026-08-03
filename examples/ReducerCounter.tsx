import { useReducer } from 'react';

type Action = { type: 'increment' } | { type: 'reset' };

function counterReducer(state: number, action: Action): number {
  if (action.type === 'reset') return 0;
  return state + 1;
}

export function ReducerCounter() {
  const [count, dispatch] = useReducer(counterReducer, 0);

  return <button onClick={() => dispatch({ type: 'increment' })}>Count: {count}</button>;
}
