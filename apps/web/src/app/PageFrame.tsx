/**
 * The chrome every production screen shares: the wordmark and a way back to the home
 * screen.
 *
 * It also carries the skip link. The match screen is tall and must be usable from a
 * keyboard alone, which means not re-crossing the header on every repaint. The link is
 * the first focusable thing on every screen and is visible only while it holds focus.
 *
 * It moves focus itself rather than letting the browser follow the fragment, so that
 * skipping the header leaves no `#page-main` in the address bar and no history entry to
 * walk back through. The `href` stays so the control is a link to anyone reading the
 * markup.
 *
 * `compact` is the match screens' header: one line holding the wordmark, the title and
 * the back link, so the status bar and the table start within the first viewport.
 *
 * The footer is drawn only when a screen gives it content through `footer`, such as the
 * match screen's settings. A screen with nothing to put there ends at its main content.
 */
import { useCallback, type MouseEvent, type ReactNode } from 'react';

import { ROUTES } from './routes';

export function PageFrame({
  title,
  lede,
  children,
  back,
  wide = false,
  compact = false,
  footer,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  /** Omitted on the home screen, which is where every other screen goes back to. */
  back?: { href: string; label: string };
  /**
   * Widen the column. Reading screens stay at a comfortable measure; the match table
   * does not, because the board is the dominant surface with the seats and the market
   * beside it rather than under it.
   */
  wide?: boolean;
  /** A one-line header with the back link inline, for screens whose content must start high. */
  compact?: boolean;
  /** Content drawn in the footer, such as a screen's settings. No footer is drawn without it. */
  footer?: ReactNode;
}) {
  const skip = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById('page-main')?.focus();
  }, []);
  const classes = [
    'page',
    wide ? 'page--wide' : '',
    compact ? 'page--compact' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <a className="skip-link" href="#page-main" onClick={skip}>
        Skip to the main content
      </a>
      <header className={compact ? 'page__header page__header--compact' : 'page__header'}>
        <div className="page__titles">
          <p className="page__wordmark">
            {back === undefined ? 'Gerrymander' : <a href={ROUTES.home}>Gerrymander</a>}
          </p>
          <h1>{title}</h1>
          {lede === undefined ? null : <p className="page__lede">{lede}</p>}
        </div>
        {compact && back !== undefined ? (
          <p className="page__back page__back--inline">
            <a href={back.href}>← {back.label}</a>
          </p>
        ) : null}
      </header>
      {back === undefined || compact ? null : (
        <p className="page__back">
          <a href={back.href}>← {back.label}</a>
        </p>
      )}
      <main className="page__main" id="page-main" tabIndex={-1}>
        {children}
      </main>
      {footer === undefined || footer === null || footer === false ? null : (
        <footer className="page__footer">{footer}</footer>
      )}
    </div>
  );
}
