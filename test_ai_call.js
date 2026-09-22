require('dotenv').config();
const { callGemini, buildDerivMetrics, buildAnalysisPrompt } = require('./dist/strategy/deriv/helpers/deriv-ai-analysis');
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/arbtrader');
  const DerivTrade = mongoose.model('DerivTrade', new mongoose.Schema({}, { strict: false }));
  
  const trades = await DerivTrade.find({ status: 'executed' }).limit(50).lean();
  const metrics = buildDerivMetrics(trades);
  const prompt = buildAnalysisPrompt(metrics);
  
  console.log("AI_PROVIDER:", process.env.AI_PROVIDER);
  console.log("GEMINI_API_KEY presente:", Boolean(process.env.GEMINI_API_KEY));
  console.log("GEMINI_MODEL:", process.env.GEMINI_MODEL);

  try {
    const res = await callGemini(process.env.GEMINI_API_KEY, prompt, process.env.GEMINI_MODEL || 'gemini-2.5-flash');
    console.log("\nRESPOSTA DA IA SUCESSO:\n", res);
  } catch (err) {
    console.error("ERRO AO CHAMAR IA:", err.response?.data || err.message);
  }
  process.exit(0);
}
run();
