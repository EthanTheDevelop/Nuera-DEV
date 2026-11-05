import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react';

/**
 * Shared polymorphism for every clickable primitive: a <button> by default, a link when `href` is set
 * (internal paths use next/link; `external` opens in a new tab with rel=noopener).
 */
export type ButtonElementProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
  href?: undefined;
  external?: undefined;
  ref?: Ref<HTMLButtonElement>;
};

export type LinkElementProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className' | 'href'> & {
  href: string;
  /** Opens in a new tab (GitHub, OVH…). Internal routes stay client-side navigations. */
  external?: boolean;
  /** Links cannot be disabled: render a button instead. */
  disabled?: never;
  ref?: Ref<HTMLAnchorElement>;
};

export type ActionElementProps = ButtonElementProps | LinkElementProps;

export function isLinkProps(props: ActionElementProps): props is LinkElementProps {
  return typeof (props as LinkElementProps).href === 'string';
}

interface RenderActionArgs {
  props: ActionElementProps;
  className: string;
  children: ReactNode;
  /** Extra attributes for the rendered element (data-*, aria-*). */
  extra?: Record<string, string | boolean | undefined>;
  busy?: boolean;
}

/** Renders the element for an action primitive (button / internal link / external link). */
export function renderAction({ props, className, children, extra, busy }: RenderActionArgs) {
  if (isLinkProps(props)) {
    const { href, external, ref, ...rest } = props;
    if (external || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return (
        <a
          ref={ref}
          href={href}
          className={className}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          {...extra}
          {...rest}
        >
          {children}
        </a>
      );
    }
    return (
      <Link ref={ref} href={href} className={className} {...extra} {...rest}>
        {children}
      </Link>
    );
  }
  const { type, disabled, ref, ...rest } = props;
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={className}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...extra}
      {...rest}
    >
      {children}
    </button>
  );
}
