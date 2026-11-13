import { describe } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { defineApiScenarios } from './scenarios';

describe('API（MemoryStore）', () => {
  defineApiScenarios(() => new MemoryStore());
});
