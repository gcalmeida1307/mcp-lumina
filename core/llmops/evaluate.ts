import { Store } from '../../data/storage/database.js';

const store = new Store();
try {
  await store.init();
  const evaluations = await store.evaluations();
  const average = evaluations.length ? evaluations.reduce((sum, item) => sum + item.groundedness, 0) / evaluations.length : 0;
  console.log(JSON.stringify({ version: 'continuous-eval-v1', samples: evaluations.length, averageGroundedness: average, passRate: evaluations.length ? evaluations.filter(item => item.reviewVerdict === 'pass').length / evaluations.length : 0, evaluations }, null, 2));
} finally {
  await store.close();
}
