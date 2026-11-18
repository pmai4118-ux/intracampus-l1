import { fileURLToPath } from 'node:url';
import { CanteenRepository } from '../src/modules/canteen/canteen.repository.ts';
const repository = new CanteenRepository(process.env.CANTEEN_DB_PATH?.trim() || fileURLToPath(new URL('../data/canteen.sqlite',import.meta.url)));
try { repository.seed(); console.log('Seeded canteen menu; existing dishes and orders preserved.'); } finally { repository.close(); }
