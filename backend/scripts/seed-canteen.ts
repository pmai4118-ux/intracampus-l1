import { fileURLToPath } from 'node:url';
import { CanteenRepository, demoDishes } from '../src/modules/canteen/canteen.repository.ts';
const repository = new CanteenRepository(process.env.CANTEEN_DB_PATH?.trim() || fileURLToPath(new URL('../data/canteen.sqlite',import.meta.url)));
try { repository.syncCatalogPrices(demoDishes); console.log(`Seeded & synced canteen menu (${repository.menu().length} dishes); existing orders preserved.`); } finally { repository.close(); }
