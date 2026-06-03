import neo4j from 'neo4j-driver';
import type { Neo4jConfig } from '@/interfaces';

export const createDriver = async (config: Neo4jConfig) => {
  return neo4j.driver(
    `${config.scheme}://${config.host}:${config.port}`,
    neo4j.auth.basic(config.username, config.password),
  );
};

export function regexp(str: TemplateStringsArray, ...values: string[]) {
  const pattern = str.reduce((acc, part, index) => {
    // Insert the dynamic values between the static parts
    const value = values[index] ? values[index].replace(/[.*+?^=!:${}()|[\]/\\]/g, '\\$&') : '';
    return acc + part + value;
  }, '');
  // Return the RegExp object
  return new RegExp(pattern);
}
