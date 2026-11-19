import { describe, expect, it } from 'vitest';
import { AppController } from '../src/app.controller';

describe('AppController', () => {
  it('returns the liveness contract', () => {
    expect(new AppController().getHealth()).toEqual({
      status: 'ok',
      service: 'gym-dev-hub-api',
    });
  });
});
