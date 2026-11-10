import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/projects" className="brand">
          Workbox
        </Link>
        <nav>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <a href="/docs" target="_blank" rel="noreferrer">
            API docs
          </a>
        </nav>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
