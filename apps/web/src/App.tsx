import { Link, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.js';
import { ConnectionsPage } from './pages/ConnectionsPage.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { TaskPage } from './pages/TaskPage.js';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:slug" element={<ProjectPage />} />
        <Route path="/tasks/:taskId" element={<TaskPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route
          path="*"
          element={
            <p>
              Page not found. <Link to="/projects">Go to projects</Link>
            </p>
          }
        />
      </Routes>
    </Layout>
  );
}
