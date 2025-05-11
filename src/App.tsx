import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import EditorPage from './pages/EditorPage';
import DropViewPage from './pages/DropViewPage'; // Import DropViewPage

// A simple 404 component
const NotFoundPage: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-muted mb-8">Oops! The page you're looking for doesn't exist.</p>
      <Link to="/" className="text-accent hover:underline">
        Go to Homepage
      </Link>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <div id="app" className="min-h-screen flex flex-col font-mono">
        {/* Optional global header can go here */}
        {/* <header className="p-4 border-b border-border sticky top-0 bg-background/80 backdrop-blur-md z-10">
          <div className="max-w-screen-xl mx-auto flex justify-between items-center">
            <Link to="/" className="text-lg font-semibold text-accent hover:underline">Nulldown</Link>
          </div>
        </header> */}
        
        <Routes>
          <Route path="/" element={<EditorPage />} />
          <Route path="/d/:id" element={<DropViewPage />} />
          <Route path="*" element={<NotFoundPage />} /> {/* Catch-all 404 route */}
        </Routes>
        
        {/* Optional global footer can go here */}
      </div>
    </Router>
  );
};

export default App; 