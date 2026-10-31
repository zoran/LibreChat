import { EModelEndpoint } from 'librechat-data-provider';
import { azureConfigSetup } from './azure';
jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn() },
}));
it('reports missing groups through the existing invalid configuration boundary', () => {
  expect(() => azureConfigSetup({ endpoints: { [EModelEndpoint.azureOpenAI]: {} } })).toThrow(
    'Invalid Azure OpenAI configuration',
  );
});
