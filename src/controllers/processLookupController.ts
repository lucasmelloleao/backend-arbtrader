import { Request, Response } from 'express';
import axios from 'axios';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function consultarProcessoTJPR(req: AuthenticatedRequest, res: Response) {
  try {
    const { numeroProcesso } = req.body;
    if (!numeroProcesso || typeof numeroProcesso !== 'string') {
      return res.status(400).json({ success: false, message: 'Número do processo obrigatório.' });
    }

    const numeroLimpo = numeroProcesso.replace(/\D/g, '');
    if (numeroLimpo.length < 3) {
      return res.status(400).json({ success: false, message: 'Digite pelo menos 3 dígitos do processo.' });
    }

    const queryDatajud = numeroLimpo.length === 20
      ? { match: { numeroProcesso: numeroLimpo } }
      : { wildcard: { numeroProcesso: `*${numeroLimpo}*` } };

    const response = await axios.post(
      'https://api-publica.datajud.cnj.jus.br/api_publica_tjpr/_search',
      {
        size: 10,
        query: queryDatajud
      },
      {
        headers: {
          'Authorization': 'APIKey cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const hits = response.data?.hits?.hits || [];
    if (hits.length === 0) {
      return res.json({
        success: true,
        message: 'Nenhum processo encontrado na base do Datajud/TJPR com este trecho ou número.',
        data: null
      });
    }

    const hit = hits[0];
    const source = hit._source;

    // Normaliza dados relevantes do Datajud
    const dadosFormatados = {
      numeroProcesso: source.numeroProcesso,
      classe: source.classe?.nome || 'N/A',
      codigoClasse: source.classe?.codigo || null,
      sistema: source.sistema?.nome || 'TJPR / Datajud',
      orgaoJulgador: source.orgaoJulgador?.nome || 'N/A',
      dataAjuizamento: source.dataAjuizamento || null,
      ultimaAtualizacao: source.dataHoraUltimaAtualizacao || null,
      grau: source.grau || 'G1',
      assuntos: (source.assuntos || []).map((a: any) => a.nome).join(', '),
      movimentos: (source.movimentos || []).map((m: any) => ({
        nome: m.nome,
        data: m.dataHora,
        complementos: (m.complementosTabelados || []).map((c: any) => `${c.nome}: ${c.descricao}`).join(' | ')
      })),
      raw: source
    };

    return res.json({
      success: true,
      message: 'Processo localizado com sucesso.',
      data: dadosFormatados
    });

  } catch (error: any) {
    console.error('❌ Erro na consulta do processo TJPR:', error.response?.data || error.message || error);
    return res.json({
      success: false,
      message: error.response?.data?.message || 'Processo não encontrado ou indisponível na base pública do Datajud/TJPR no momento.',
      data: null
    });
  }
}
