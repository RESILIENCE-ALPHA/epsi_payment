import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { saveSession } from '../api/session';

afterEach(() => {
  cleanup();
  // Efface aussi la copie en mémoire de la session
  saveSession(null);
});
