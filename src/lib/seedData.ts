import { db } from './db';
import { units } from './schema';

interface UnitSeed {
  name: string;
  capacity: number;
  active: boolean;
}

const predefinedUnits: UnitSeed[] = [
  {
    name: 'Riso',
    capacity: 10,
    active: true,
  },
];

export async function seedUnits() {
  console.log('Checking if units need to be seeded...');
  
  try {
    // Check if units already exist
    const existingUnits = await db.query.units.findMany();
    
    if (existingUnits.length > 0) {
      console.log(`Found ${existingUnits.length} existing units, skipping seed`);
      return;
    }
    
    // Insert predefined units only if none exist
    await db.insert(units).values(predefinedUnits);
    console.log(`Successfully seeded ${predefinedUnits.length} units`);
  } catch (error) {
    console.error('Failed to seed units:', error);
    throw error;
  }
}

export async function ensureSeedData() {
  try {
    await seedUnits();
  } catch (error) {
    console.error('Failed to seed data:', error);
    throw error;
  }
}
