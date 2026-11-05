import type { ReactNode } from 'react';

/**
 * Projets: the page (list, add flow on a hard load, project detail) + the `@modal` slot where the
 * add-project flow opens over the list on a soft navigation (intercepting route `(.)nouveau`).
 */
export default function ProjectsLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
