import React from "react";
import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import EditorPage from "./pages/EditorPage";
import DropViewPage from "./pages/DropViewPage";
import { ThemeProvider } from "./theme/themeContext";

// A simple 404 component
const NotFoundPage: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-muted mb-8">
        Oops! The page you're looking for doesn't exist.
      </p>
      <Link to="/" className="text-accent hover:underline">
        Go to Homepage
      </Link>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <Router>
        <div style={{ position: "fixed", inset: 0 }}>
          <Routes>
            <Route path="/" element={<EditorPage />} />
            <Route path="/d/:id" element={<DropViewPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </Router>
    </ThemeProvider>
  );
};

export default App;
