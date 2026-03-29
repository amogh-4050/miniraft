const express = require('express');
const app = express();
app.use(express.json());

const NODE_ID = process.env.NODE_ID || 'unknown';
const PORT = process.env.PORT || 3001;

app.get('/status', (req, res) => {
  res.json({ nodeId: NODE_ID, role: 'follower', term: 0 });
});

app.listen(PORT, () => console.log(`[${NODE_ID}] stub running on ${PORT}`));
console.log('[replica1] hot reload works');
