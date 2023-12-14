import {
  LobeChatPluginApi,
  LobeChatPluginManifest,
  LobeChatPluginsMarketIndex,
  PluginSchema,
  pluginApiSchema,
  pluginManifestSchema,
} from '@lobehub/chat-plugin-sdk';
import { uniq } from 'lodash-es';
import { convertParametersToJSONSchema } from 'openapi-jsonschema-parameters';
import YAML from 'yaml';

import { getPluginIndexJSON } from '@/const/url';
import { PluginModel } from '@/database/models/plugin';
import { PROXY_URL } from '@/services/_url';
import { globalHelpers } from '@/store/global/helpers';
import { OpenAIPluginManifest } from '@/types/openai/plugin';
import { LobeTool } from '@/types/tool';
import { LobeToolCustomPlugin } from '@/types/tool/plugin';
import { merge } from '@/utils/merge';

export interface InstallPluginParams {
  identifier: string;
  manifest: LobeChatPluginManifest;
  type: 'plugin' | 'customPlugin';
}
class PluginService {
  private _fetchJSON = async <T = any>(url: string, proxy = false): Promise<T> => {
    // 2. 发送请求
    let res: Response;
    try {
      res = await (proxy ? fetch(PROXY_URL, { body: url, method: 'POST' }) : fetch(url));
    } catch {
      throw new TypeError('fetchError');
    }

    if (!res.ok) {
      throw new TypeError('fetchError');
    }

    let data;
    const contentType = res.headers.get('Content-Type');

    try {
      if (contentType === 'application/json') {
        data = await res.json();
      } else {
        const yaml = await res.text();
        data = YAML.parse(yaml);
      }
    } catch {
      throw new TypeError('urlError');
    }

    return data;
  };
  /**
   * get plugin list from store
   */
  getPluginList = async () => {
    const url = getPluginIndexJSON(globalHelpers.getCurrentLanguage());

    const res = await fetch(url);

    const data: LobeChatPluginsMarketIndex = await res.json();

    return data;
  };

  getPluginManifest = async (
    url?: string,
    useProxy: boolean = false,
  ): Promise<LobeChatPluginManifest> => {
    // 1. valid plugin
    if (!url) {
      throw new TypeError('noManifest');
    }

    // 2. 发送请求

    let data = await this._fetchJSON<LobeChatPluginManifest>(url, useProxy);

    // @ts-ignore
    // if there is a description_for_model, it is an OpenAI plugin
    // we need convert to lobe plugin
    if (data['description_for_model']) {
      data = this.convertOpenAIManifestToLobeManifest(data as any);
    }

    // 3. 校验插件文件格式规范
    const parser = pluginManifestSchema.safeParse(data);

    if (!parser.success) {
      throw new TypeError('manifestInvalid', { cause: parser.error });
    }

    // 4. if exist OpenAPI api, merge the OpenAPIs to api
    if (parser.data.openapi) {
      const openapiJson = await this._fetchJSON(parser.data.openapi, useProxy);

      try {
        const openAPIs = await this.convertOpenAPIToPluginSchema(openapiJson);
        data.api = [...data.api, ...openAPIs];

        data.settings = await this.convertAuthToSettingsSchema(openapiJson, data.settings);
      } catch (error) {
        throw new TypeError('openAPIInvalid', { cause: error });
      }
    }

    return data;
  };

  installPlugin = async (plugin: InstallPluginParams) => {
    return PluginModel.create(plugin);
  };

  getInstalledPlugins = () => {
    return PluginModel.getList() as Promise<LobeTool[]>;
  };

  uninstallPlugin(identifier: string) {
    return PluginModel.delete(identifier);
  }

  async createCustomPlugin(customPlugin: LobeToolCustomPlugin) {
    return PluginModel.create({ ...customPlugin, type: 'customPlugin' });
  }

  async updatePlugin(id: string, value: LobeToolCustomPlugin) {
    return PluginModel.update(id, value);
  }
  async updatePluginManifest(id: string, manifest: LobeChatPluginManifest) {
    return PluginModel.update(id, { manifest });
  }

  async removeAllPlugins() {
    return PluginModel.clear();
  }

  async updatePluginSettings(id: string, settings: any) {
    return PluginModel.update(id, { settings });
  }

  convertOpenAPIToPluginSchema = async (openApiJson: object) => {
    // @ts-ignore
    const { default: SwaggerClient } = await import('swagger-client');

    // 使用 SwaggerClient 解析 OpenAPI JSON
    const openAPI = await SwaggerClient.resolve({ spec: openApiJson });

    const api = openAPI.spec;
    const paths = api.paths;
    const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

    const plugins: LobeChatPluginApi[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      for (const method of methods) {
        const operation = (operations as any)[method];
        if (operation) {
          const schemas = convertParametersToJSONSchema(operation.parameters || []);

          let parameters = { properties: {}, type: 'object' };
          for (const schema of Object.values(schemas)) {
            parameters = merge(parameters, schema);
          }

          // 保留原始逻辑作为备选
          const name = operation.operationId || `${method.toUpperCase()} ${path}`;

          const description = operation.summary || operation.description || name;

          const plugin = { description, name, parameters } as LobeChatPluginApi;

          const res = pluginApiSchema.safeParse(plugin);
          if (res.success) plugins.push(plugin);
          else {
            throw res.error;
          }
        }
      }
    }

    return plugins;
  };

  convertAuthToSettingsSchema = async (
    openApiJson: any,
    // eslint-disable-next-line unicorn/no-object-as-default-parameter
    rawSettingsSchema: PluginSchema = { properties: {}, type: 'object' },
  ): Promise<PluginSchema> => {
    let settingsSchema = rawSettingsSchema;

    // @ts-ignore
    const { default: SwaggerClient } = await import('swagger-client');

    // 使用 SwaggerClient 解析 OpenAPI JSON
    const openAPI = await SwaggerClient.resolve({ spec: openApiJson });
    const api = openAPI.spec;

    for (const entry of Object.entries(api.components?.securitySchemes || {})) {
      let authSchema = {} as PluginSchema;
      const [key, value] = entry as [string, any];

      switch (value.type) {
        case 'apiKey': {
          authSchema = {
            properties: {
              [key]: {
                description: value.description || `${key} API Key`,
                format: 'password',
                title: value.name,
                type: 'string',
              },
            },
            required: [key],
            type: 'object',
          };
          break;
        }
        case 'http': {
          if (value.scheme === 'basic') {
            authSchema = {
              properties: {
                [key]: {
                  description: 'Basic authentication credentials',
                  format: 'password',
                  type: 'string',
                },
              },
              required: [key],
              type: 'object',
            };
          } else if (value.scheme === 'bearer') {
            authSchema = {
              properties: {
                [key]: {
                  description: value.description || `${key} Bearer token`,
                  format: 'password',
                  title: key,
                  type: 'string',
                },
              },
              required: [key],
              type: 'object',
            };
          }
          break;
        }
        case 'oauth2': {
          authSchema = {
            properties: {
              [`${key}_clientId`]: {
                description: 'Client ID for OAuth2',
                type: 'string',
              },
              [`${key}_clientSecret`]: {
                description: 'Client Secret for OAuth2',
                format: 'password',
                type: 'string',
              },
              [`${key}_accessToken`]: {
                description: 'Access token for OAuth2',
                format: 'password',
                type: 'string',
              },
            },
            required: [`${key}_clientId`, `${key}_clientSecret`, `${key}_accessToken`],
            type: 'object',
          };
          break;
        }
      }

      // 合并当前鉴权机制的 schema 到 settingsSchema
      settingsSchema.properties = merge(settingsSchema.properties, authSchema.properties);

      if (authSchema.required) {
        settingsSchema.required = uniq([
          ...(settingsSchema.required || []),
          ...authSchema.required,
        ]);
      }
    }

    return settingsSchema;
  };

  private convertOpenAIManifestToLobeManifest = (
    data: OpenAIPluginManifest,
  ): LobeChatPluginManifest => {
    const manifest: LobeChatPluginManifest = {
      api: [],
      homepage: data.legal_info_url,
      identifier: data.name_for_model,
      meta: {
        avatar: data.logo_url,
        description: data.description_for_human,
        title: data.name_for_human,
      },
      openapi: data.api.url,

      type: 'default',
      version: '1',
    };
    switch (data.auth.type) {
      case 'none': {
        break;
      }
      case 'service_http': {
        manifest.settings = {
          properties: {
            apiAuthKey: {
              default: data.auth.verification_tokens['openai'],
              description: 'API Key',
              format: 'password',
              title: 'API Key',
              type: 'string',
            },
          },
          type: 'object',
        };
        break;
      }
    }

    return manifest;
  };
}

export const pluginService = new PluginService();
