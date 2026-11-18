import { handleFailure, run } from './run';

run().catch(handleFailure);
