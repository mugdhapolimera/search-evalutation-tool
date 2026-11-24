import '@testing-library/jest-dom/vitest';

// jsdom has no layout, so it has no scrollIntoView.
Element.prototype.scrollIntoView = () => {};
