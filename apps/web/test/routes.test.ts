// @vitest-environment jsdom
/**
 * The address bar, as the shell reads and writes it.
 *
 * `online-model.test.ts` covers the parsing, which is pure. This covers the two things
 * that touch the browser: the correction of a legacy `#/…` address, and that navigating
 * to the address already showing pushes nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ROUTE_CHANGE_EVENT, navigate, redirectLegacyHashRoute } from '../src/app/routes';

function open(address: string): void {
  window.history.replaceState(null, '', address);
}

describe('a legacy hash address', () => {
  beforeEach(() => open('/'));

  it('becomes the path it names', () => {
    open('/#/match/local-1');
    expect(redirectLegacyHashRoute()).toBe(true);
    expect(window.location.pathname).toBe('/match/local-1');
    expect(window.location.hash).toBe('');
  });

  it('announces the correction, so the shell re-reads the address', () => {
    open('/#/online/join/ABCD2345');
    let announced = 0;
    const listen = () => { announced += 1; };
    window.addEventListener(ROUTE_CHANGE_EVENT, listen);
    redirectLegacyHashRoute();
    window.removeEventListener(ROUTE_CHANGE_EVENT, listen);
    expect(announced).toBe(1);
    expect(window.location.pathname).toBe('/online/join/ABCD2345');
  });

  it('leaves a fragment that names something on the page, such as the skip link', () => {
    open('/rules#page-main');
    expect(redirectLegacyHashRoute()).toBe(false);
    expect(window.location.pathname).toBe('/rules');
    expect(window.location.hash).toBe('#page-main');
  });

  it('leaves an address that carries no fragment at all', () => {
    open('/rules');
    expect(redirectLegacyHashRoute()).toBe(false);
    expect(window.location.pathname).toBe('/rules');
  });
});

describe('navigating', () => {
  beforeEach(() => open('/'));

  it('pushes the route it is given', () => {
    const before = window.history.length;
    navigate('/rules');
    expect(window.location.pathname).toBe('/rules');
    expect(window.history.length).toBe(before + 1);
  });

  it('drops a navigation to the address already showing', () => {
    open('/rules');
    const before = window.history.length;
    navigate('/rules');
    expect(window.history.length).toBe(before);
  });
});
