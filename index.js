require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-current-affairs-service' }));

app.use('/current-affairs', require('./routes'));

// Unknown routes and unhandled errors answer in JSON like the rest of the API.
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars -- Express needs the 4-argument signature
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error('[current-affairs] unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// 3015 is taken locally by aivorah-assignments-service, so the local default is 3024.
// Render sets PORT itself.
const PORT = process.env.PORT || 3024;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Current Affairs service running on port ${PORT}`);
  });
}

module.exports = app;
