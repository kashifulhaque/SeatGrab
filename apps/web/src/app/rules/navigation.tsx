/**
 * Finding your place in the rulebook.
 *
 * The rulebook is one long page read top to bottom, so the navigation is a bookmark
 * rather than a switch: a row of chapter pills on a phone and a rail beside the text on
 * a desktop, both showing which chapter is under the reader's eye, plus a thin progress
 * bar along the top edge. Clicking a chapter scrolls to it and moves focus to its
 * heading, so a keyboard reader continues from the chapter rather than from the pill.
 *
 * Everything here observes the document; nothing here decides what a chapter says. The
 * observers are torn down on unmount and, where `IntersectionObserver` is missing, every
 * chapter is shown at once rather than hidden behind an animation that never fires.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

export interface ChapterLink {
  id: string;
  /** The label on the pill. Short, because six of them share one phone width. */
  short: string;
  /** The heading the section shows. */
  title: string;
  /** Appendices are drawn quieter in the rail and never count toward the tour. */
  appendix?: boolean;
}

/** The DOM id a chapter's section carries, and the hash that points at it. */
export function sectionId(chapterId: string): string {
  return `rb-${chapterId}`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scroll to a chapter and hand it focus.
 *
 * The hash is replaced rather than pushed: a reader who taps six pills should not need
 * six presses of Back to leave the rulebook.
 */
export function goToChapter(chapterId: string, behavior: ScrollBehavior = 'smooth'): void {
  const section = document.getElementById(sectionId(chapterId));
  if (section === null) return;
  section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : behavior, block: 'start' });
  window.history.replaceState(null, '', `#${sectionId(chapterId)}`);
  const heading = section.querySelector<HTMLElement>('h2');
  (heading ?? section).focus({ preventScroll: true });
}

/**
 * Open on the chapter the address names, if it names one.
 *
 * The browser scrolls to a fragment while the document parses, which is before React
 * has drawn a single chapter, so a shared link to `/rules#rb-power` would otherwise land
 * on the top of the page.
 */
export function useOpenOnHash(chapterIds: readonly string[]): void {
  useEffect(() => {
    const id = chapterFromHash(chapterIds);
    if (id !== undefined) goToChapter(id, 'auto');
  }, [chapterIds]);
}

/** The chapter the address's fragment names, if it names one. */
function chapterFromHash(chapterIds: readonly string[]): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const hash = window.location.hash.replace(/^#/, '');
  return chapterIds.find((chapterId) => sectionId(chapterId) === hash);
}

/**
 * Which chapter is under the reading line.
 *
 * A band a third of the way down the viewport is the reading line; the chapter that
 * crosses it is the active one. Between two chapters the band may be empty, and then
 * the previous answer stands rather than flickering to none.
 */
export function useActiveChapter(chapterIds: readonly string[]): string {
  // A page opened on a chapter's hash starts on that chapter rather than waiting for
  // the observer's first report, which a background tab may not deliver until it is shown.
  const [active, setActive] = useState<string>(() => chapterFromHash(chapterIds) ?? chapterIds[0] ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sections = chapterIds
      .map((id) => document.getElementById(sectionId(id)))
      .filter((node): node is HTMLElement => node !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id.replace(/^rb-/, '');
          setActive(id);
        }
      },
      { rootMargin: '-30% 0px -62% 0px', threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [chapterIds]);
  return active;
}

/**
 * Mark sections and figures as they enter the viewport, once each.
 *
 * The class is what the stylesheet animates on. Chapters already in the first viewport
 * are marked on the first pass, so nothing a reader can see is waiting on a scroll.
 */
export function useRevealOnScroll(root: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = root.current;
    if (container === null) return;
    const targets = container.querySelectorAll<HTMLElement>('.rb-chapter, .rb-figure');
    if (typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) {
      for (const target of targets) target.classList.add('rb-in');
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('rb-in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [root]);
}

/** How far down the document the reader is, 0 to 1, written to a CSS variable. */
export function useReadingProgress(bar: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const node = bar.current;
      if (node === null) return;
      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, window.scrollY / total));
      node.style.setProperty('--rb-progress', progress.toFixed(4));
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [bar]);
}

/** The thin amber line along the top edge that fills as the reader scrolls. */
export function ProgressBar() {
  const bar = useRef<HTMLDivElement>(null);
  useReadingProgress(bar);
  return <div className="rb-progress" ref={bar} aria-hidden="true" />;
}

/**
 * The chapter list: pills on a phone, a rail on a desktop.
 *
 * It is one `nav` styled two ways, so there is one active state to keep and one set of
 * links a screen reader hears. The sliding marker is a separate element moved under the
 * active link, because a background that jumps from pill to pill tells the reader
 * nothing about direction.
 */
export function JumpNav({ chapters, active }: { chapters: readonly ChapterLink[]; active: string }) {
  const list = useRef<HTMLOListElement>(null);
  const marker = useRef<HTMLLIElement>(null);

  // Keep the active pill in view and slide the marker under it.
  useLayoutEffect(() => {
    const container = list.current;
    const link = container?.querySelector<HTMLAnchorElement>(`[data-chapter="${active}"]`);
    if (container === undefined || container === null || link === null || link === undefined) return;
    const mark = marker.current;
    if (mark !== null) {
      mark.style.setProperty('--rb-marker-x', `${link.offsetLeft}px`);
      mark.style.setProperty('--rb-marker-y', `${link.offsetTop}px`);
      mark.style.setProperty('--rb-marker-w', `${link.offsetWidth}px`);
      mark.style.setProperty('--rb-marker-h', `${link.offsetHeight}px`);
      mark.classList.add('rb-jump__marker--ready');
    }
    if (container.scrollWidth > container.clientWidth) {
      const target = link.offsetLeft - (container.clientWidth - link.offsetWidth) / 2;
      container.scrollTo({ left: Math.max(0, target), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [active]);

  const onClick = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    goToChapter(id);
  }, []);

  return (
    <nav className="rb-jump" aria-label="Rulebook chapters">
      <ol className="rb-jump__list" ref={list}>
        <li className="rb-jump__marker" ref={marker} aria-hidden="true" />
        {chapters.map((chapter, index) => {
          const current = chapter.id === active;
          return (
            <li key={chapter.id} className={chapter.appendix ? 'rb-jump__item rb-jump__item--appendix' : 'rb-jump__item'}>
              <a
                href={`#${sectionId(chapter.id)}`}
                className={current ? 'rb-jump__link rb-jump__link--active' : 'rb-jump__link'}
                data-chapter={chapter.id}
                aria-current={current ? 'true' : undefined}
                onClick={(event) => onClick(event, chapter.id)}
              >
                <span className="rb-jump__n" aria-hidden="true">{chapter.appendix ? '§' : index + 1}</span>
                <span className="rb-jump__label">{chapter.short}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The link at the foot of a chapter that carries the tour on. */
export function NextChapter({ chapter }: { chapter: ChapterLink | undefined }) {
  if (chapter === undefined) return null;
  return (
    <p className="rb-next">
      <a
        href={`#${sectionId(chapter.id)}`}
        className="rb-next__link"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          goToChapter(chapter.id);
        }}
      >
        <span className="rb-next__eyebrow">Next chapter</span>
        <span className="rb-next__title">{chapter.title} →</span>
      </a>
    </p>
  );
}
