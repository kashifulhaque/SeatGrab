/**
 * The chrome every production screen shares: the wordmark, a way back to the home screen,
 * and — on the reading screens — the installed edition.
 *
 * It also carries the skip link. The match screen is tall and section 13.10 asks for it
 * to be usable from a keyboard alone, which means not re-crossing the header on every
 * repaint. The link is the first focusable thing on every screen and is visible only
 * while it holds focus.
 *
 * It moves focus itself rather than letting the browser follow the fragment, because
 * this application routes on the hash: navigating to `#page-main` would be read as a
 * route and would land the player on the home screen instead of the content they asked
 * to skip to. The `href` stays so the control is a link to anyone reading the markup.
 *
 * `compact` is the match screens' header: one line holding the wordmark, the title and
 * the back link, so the status bar and the table start within the first viewport. The
 * edition facts those screens used to print join the match settings in the footer, which
 * is what `footer` is for.
 */
import { useCallback, type MouseEvent, type ReactNode } from 'react';

import { INSTALLED_CAMPAIGN } from './edition';
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
   * does not, because section 13.4 asks for the board to be the dominant surface with
   * the seats and the market beside it rather than under it.
   */
  wide?: boolean;
  /** A one-line header with no edition facts, for screens whose content must start high. */
  compact?: boolean;
  /** Content drawn in the footer above the rules link, such as a screen's settings. */
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
            {back === undefined ? 'SeatGrab' : <a href={ROUTES.home}>SeatGrab</a>}
          </p>
          <h1>{title}</h1>
          {lede === undefined ? null : <p className="page__lede">{lede}</p>}
        </div>
        {compact ? (
          back === undefined ? null : (
            <p className="page__back page__back--inline">
              <a href={back.href}>← {back.label}</a>
            </p>
          )
        ) : (
          <p className="page__edition">
            {INSTALLED_CAMPAIGN.displayName}
            <span>
              content {INSTALLED_CAMPAIGN.contentPackId} {INSTALLED_CAMPAIGN.contentVersion}
            </span>
            <span>
              board {INSTALLED_CAMPAIGN.boardId} {INSTALLED_CAMPAIGN.boardVersion}
            </span>
          </p>
        )}
      </header>
      {back === undefined || compact ? null : (
        <p className="page__back">
          <a href={back.href}>← {back.label}</a>
        </p>
      )}
      <main className="page__main" id="page-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="page__footer">
        {footer}
        <a href={ROUTES.rules}>Rules and house rules</a>
      </footer>
    </div>
  );
}
