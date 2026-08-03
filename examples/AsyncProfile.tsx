import { useState } from 'react';

export function AsyncProfile() {
  const [profile, setProfile] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);

  async function loadProfile() {
    setLoading(true);
    try {
      const response = await fetch('/api/profile');
      const user = await response.json();
      setProfile(user);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }

  return <button onClick={loadProfile}>{loading ? 'Loading…' : 'Load profile'}</button>;
}
