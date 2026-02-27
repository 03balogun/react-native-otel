// Globals required by React Native that don't exist in Node.js test environment

(global as Record<string, unknown>).__DEV__ = false;

(global as Record<string, unknown>).ErrorUtils = {
  setGlobalHandler: jest.fn(),
  getGlobalHandler: jest.fn(() => undefined),
};
