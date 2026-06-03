import { Controller, Get, Header } from '@nestjs/common';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { GET_DISEASES_QUERY } from '@/neo4j/neo4j.constants';
import { Disease } from './interfaces';

@Controller()
export class AppController {
  constructor(private readonly neo4jService: Neo4jService) {}

  @Get()
  getHello(): string {
    return 'Welcome to the TBEP API!';
  }

  @Get('count-nodes')
  async getCount(): Promise<string> {
    const session = this.neo4jService.getSession();
    const res = await session.run(`MATCH (n) RETURN count(n) AS count`);
    await this.neo4jService.releaseSession(session);
    return `There are ${res.records[0].get('count')} nodes in the database`;
  }

  @Get('diseases')
  @Header('Cache-Control', 'public, max-age=86400, s-maxage=86400')
  async getDiseases(): Promise<Disease[]> {
    const session = this.neo4jService.getSession();
    const result = await session.run<{ diseases: Disease }>(GET_DISEASES_QUERY);
    await this.neo4jService.releaseSession(session);
    return result.records.map((record) => record.get('diseases'));
  }
}
