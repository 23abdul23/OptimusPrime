import { Injectable } from '@nestjs/common';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { FIRST_ORDER_GENES_QUERY, LEIDEN_QUERY, RENEW_QUERY } from '@/neo4j/neo4j.constants';
import { GraphConfigDto } from '@/algorithm/algorithm.dto';
import { RedisService } from '@/redis/redis.service';

@Injectable()
export class AlgorithmService {
  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly redisService: RedisService,
  ) {}

  // https://stackoverflow.com/a/54014428/1376947
  hslToHex(h: number, s: number, l: number) {
    l /= 100;
    const a = (s * Math.min(l, 1 - l)) / 100;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color)
        .toString(16)
        .padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  colorGenerator() {
    let count = 0;
    const cssColors = [
      '#FF0000',
      '#0000CD',
      '#ADFF2F',
      '#FF00FF',
      '#00FFFF',
      '#FF8C00',
      '#2F4F4F',
      '#FF1493',
      '#CD853F',
      '#F0FFF0',
      '#000000',
      '#C71585',
      '#00008B',
      '#FFD700',
      '#9400D3',
      '#7FFFD4',
      '#FFA500',
      '#708090',
      '#FF69B4',
      '#F4A460',
      '#FDF5E6',
      '#B22222',
      '#00FF7F',
      '#000080',
      '#9ACD32',
      '#BA55D3',
      '#40E0D0',
      '#FF7F50',
      '#A9A9A9',
      '#FFC0CB',
      '#8B4513',
      '#FFFFF0',
      '#800000',
      '#008000',
      '#7B68EE',
      '#DAA520',
      '#4B0082',
      '#00CED1',
      '#FA8072',
      '#696969',
      '#FFE4E1',
      '#A0522D',
      '#FAF0E6',
      '#CD5C5C',
      '#006400',
      '#4169E1',
      '#B8860B',
      '#800080',
      '#66CDAA',
      '#F08080',
      '#808080',
      '#E6E6FA',
      '#D2B48C',
      '#FFF5EE',
      '#DB7093',
      '#808000',
      '#6A5ACD',
      '#F0E68C',
      '#EE82EE',
      '#008080',
      '#E9967A',
      '#D3D3D3',
      '#FFF0F5',
      '#FFE4C4',
      '#F5F5F5',
      '#90EE90',
      '#1E90FF',
      '#BDB76B',
      '#663399',
      '#AFEEEE',
      '#C0C0C0',
      '#BC8F8F',
      '#6B8E23',
      '#6495ED',
      '#F5DEB3',
      '#9370DB',
      '#E0FFFF',
      '#D2691E',
      '#3CB371',
      '#00BFFF',
      '#FFFACD',
      '#DDA0DD',
      '#A52A2A',
      '#2E8B57',
      '#483D8B',
      '#FFFF00',
      '#D8BFD8',
      '#DEB887',
      '#20B2AA',
      '#4682B4',
      '#556B2F',
      '#87CEFA',
      '#8FBC8F',
      '#87CEEB',
      '#ADD8E6',
      '#B0C4DE',
      '#F5F5DC',
      '#F0F8FF',
      '#0000FF',
      '#8A2BE2',
      '#5F9EA0',
    ];
    const goldenAngle = 137.507764;
    return () => {
      if (count < cssColors.length) {
        return cssColors[count++];
      }
      let h = (count * goldenAngle) % 360;
      const s = 40 + (count % 4) * 20;
      let l = 20 + (count % 5) * 15;
      if (h > 60 && h < 180) {
        l = l < 50 ? l + 10 : l - 10;
        h = h < 120 ? h + 60 : h - 60;
      }
      count++;
      return this.hslToHex(h, s, l);
    };
  }

  async leiden(graphName: string, resolution: number, weighted: boolean, minCommunitySize: number) {
    if (!(await this.neo4jService.graphExists(graphName))) return;
    const session = this.neo4jService.getSession();
    const response = (
      await session.run<{
        community: { ID: string; communityId: number }[];
        modularity: number;
      }>(LEIDEN_QUERY(minCommunitySize, weighted), { graphName, resolution })
    ).records[0];
    await this.neo4jService.releaseSession(session);
    const colorGen = this.colorGenerator();
    let count = 0;
    return {
      modularity: response.get('modularity').toFixed(3),
      communities: response.get('community').reduce((acc, { ID, communityId }) => {
        if (!acc[communityId]) {
          acc[communityId] = { name: `Community ${++count}`, color: colorGen(), genes: [] };
        }
        acc[communityId].genes.push(ID);
        return acc;
      }, {}),
    };
  }

  async renewSession(graphConfig: GraphConfigDto) {
    if (await this.neo4jService.graphExists(graphConfig.graphName)) return false;
    const session = this.neo4jService.getSession();
    if (graphConfig.order === 2) {
      graphConfig.order = 0;
      graphConfig.geneIDs = (
        await session.run<{ geneIDs: string[] }>(FIRST_ORDER_GENES_QUERY(graphConfig.interactionType), {
          geneIDs: graphConfig.geneIDs,
          minScore: graphConfig.minScore,
        })
      ).records[0].get('geneIDs');
    }
    await session.run(RENEW_QUERY(graphConfig.order, graphConfig.interactionType), {
      geneIDs: graphConfig.geneIDs,
      minScore: graphConfig.minScore,
      graphName: graphConfig.graphName,
    });
    await this.neo4jService.releaseSession(session);
    await this.redisService.redisClient.set(graphConfig.graphName, '', 'EX', 60);
    return true;
  }
}
