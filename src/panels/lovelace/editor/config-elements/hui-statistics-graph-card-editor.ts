import {
  css,
  CSSResultGroup,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
} from "lit";
import { customElement, property, state } from "lit/decorators";
import memoizeOne from "memoize-one";
import {
  array,
  assert,
  assign,
  literal,
  number,
  object,
  optional,
  string,
  union,
} from "superstruct";
import { fireEvent } from "../../../../common/dom/fire_event";
import { ensureArray } from "../../../../common/ensure-array";
import type { LocalizeFunc } from "../../../../common/translations/localize";
import { deepEqual } from "../../../../common/util/deep-equal";
import { statTypeMap } from "../../../../components/chart/statistics-chart";
import "../../../../components/entity/ha-statistics-picker";
import "../../../../components/ha-form/ha-form";
import type { HaFormSchema } from "../../../../components/ha-form/types";
import {
  getDisplayUnit,
  getStatisticMetadata,
  isExternalStatistic,
  StatisticsMetaData,
  statisticsMetaHasType,
} from "../../../../data/recorder";
import type { HomeAssistant } from "../../../../types";
import type { StatisticsGraphCardConfig } from "../../cards/types";
import { processConfigEntities } from "../../common/process-config-entities";
import type { LovelaceCardEditor } from "../../types";
import { baseLovelaceCardConfig } from "../structs/base-card-struct";
import { entitiesConfigStruct } from "../structs/entities-struct";

const statTypeStruct = union([
  literal("state"),
  literal("sum"),
  literal("min"),
  literal("max"),
  literal("mean"),
]);

const cardConfigStruct = assign(
  baseLovelaceCardConfig,
  object({
    entities: array(entitiesConfigStruct),
    title: optional(string()),
    days_to_show: optional(number()),
    period: optional(
      union([
        literal("5minute"),
        literal("hour"),
        literal("day"),
        literal("week"),
        literal("month"),
      ])
    ),
    chart_type: optional(union([literal("bar"), literal("line")])),
    stat_types: optional(union([array(statTypeStruct), statTypeStruct])),
    unit: optional(string()),
  })
);

const periods = ["5minute", "hour", "day", "week", "month"] as const;
const stat_types = ["mean", "min", "max", "sum", "state"] as const;

@customElement("hui-statistics-graph-card-editor")
export class HuiStatisticsGraphCardEditor
  extends LitElement
  implements LovelaceCardEditor
{
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config?: StatisticsGraphCardConfig;

  @state() private _configEntities?: string[];

  @state() private _metaDatas?: StatisticsMetaData[];

  public setConfig(config: StatisticsGraphCardConfig): void {
    assert(config, cardConfigStruct);
    this._config = config;
    this._configEntities = config.entities
      ? processConfigEntities(config.entities, false).map((cfg) => cfg.entity)
      : [];
  }

  private _getStatisticsMetaData = async (statisticIds?: string[]) => {
    this._metaDatas = await getStatisticMetadata(
      this.hass!,
      statisticIds || []
    );
  };

  public willUpdate(changedProps: PropertyValues) {
    if (
      changedProps.has("_configEntities") &&
      !deepEqual(this._configEntities, changedProps.get("_configEntities"))
    ) {
      this._metaDatas = undefined;
      this._getStatisticsMetaData(this._configEntities);
    }
  }

  private _schema = memoizeOne(
    (
      localize: LocalizeFunc,
      statisticIds: string[] | undefined,
      metaDatas: StatisticsMetaData[] | undefined
    ) => {
      const units = new Set<string>();
      metaDatas?.forEach((metaData) => {
        const unit = getDisplayUnit(
          this.hass!,
          metaData.statistic_id,
          metaData
        );
        if (unit) {
          units.add(unit);
        }
      });
      const schema: HaFormSchema[] = [
        { name: "title", selector: { text: {} } },
        {
          name: "",
          type: "grid",
          schema: [
            {
              name: "period",
              required: true,
              selector: {
                select: {
                  options: periods.map((period) => ({
                    value: period,
                    label: localize(
                      `ui.panel.lovelace.editor.card.statistics-graph.periods.${period}`
                    ),
                    disabled:
                      period === "5minute" &&
                      // External statistics don't support 5-minute statistics.
                      statisticIds?.some((statistic_id) =>
                        isExternalStatistic(statistic_id)
                      ),
                  })),
                },
              },
            },
            {
              name: "days_to_show",
              required: true,
              selector: { number: { min: 1, mode: "box" } },
            },
            {
              name: "stat_types",
              required: true,
              selector: {
                select: {
                  multiple: true,
                  options: stat_types.map((stat_type) => ({
                    value: stat_type,
                    label: localize(
                      `ui.panel.lovelace.editor.card.statistics-graph.stat_type_labels.${stat_type}`
                    ),
                    disabled:
                      !metaDatas ||
                      !metaDatas.every((metaData) =>
                        statisticsMetaHasType(metaData, statTypeMap[stat_type])
                      ),
                  })),
                },
              },
            },
            {
              name: "chart_type",
              required: true,
              type: "select",
              options: [
                ["line", "Line"],
                ["bar", "Bar"],
              ],
            },
          ],
        },
      ];

      if (units.size > 1) {
        (schema[1] as any).schema.push({
          name: "unit",
          required: false,
          selector: {
            select: {
              options: Array.from(units).map((unit) => ({
                value: unit,
                label: unit,
              })),
            },
          },
        });
      }

      return schema;
    }
  );

  protected render(): TemplateResult {
    if (!this.hass || !this._config) {
      return html``;
    }

    const schema = this._schema(
      this.hass.localize,
      this._configEntities,
      this._metaDatas
    );
    const configured_stat_types = this._config!.stat_types
      ? Array.isArray(this._config!.stat_types)
        ? this._config!.stat_types
        : [this._config!.stat_types]
      : stat_types.filter((stat_type) =>
          this._metaDatas?.every((metaData) =>
            statisticsMetaHasType(metaData, statTypeMap[stat_type])
          )
        );
    const data = {
      chart_type: "line",
      period: "hour",
      days_to_show: 30,
      ...this._config,
      stat_types: configured_stat_types,
    };
    const unitClass = this._metaDatas?.[0]?.unit_class;
    const statisticsUnit = unitClass
      ? undefined
      : this._metaDatas?.[0]?.statistics_unit_of_measurement;

    return html`
      <ha-form
        .hass=${this.hass}
        .data=${data}
        .schema=${schema}
        .computeLabel=${this._computeLabelCallback}
        @value-changed=${this._valueChanged}
      ></ha-form>
        <ha-statistics-picker
          .hass=${this.hass}
          .pickStatisticLabel=${this.hass!.localize(
            "ui.panel.lovelace.editor.card.statistics-graph.pick_statistic"
          )}
          .pickedStatisticLabel=${this.hass!.localize(
            "ui.panel.lovelace.editor.card.statistics-graph.picked_statistic"
          )}
          .includeStatisticsUnitOfMeasurement=${statisticsUnit}
          .includeUnitClass=${unitClass}
          .ignoreRestrictionsOnFirstStatistic=${true}
          .value=${this._configEntities}
          .configValue=${"entities"}
          @value-changed=${this._entitiesChanged}
        ></ha-statistics-picker>
      </div>
    `;
  }

  private _valueChanged(ev: CustomEvent): void {
    fireEvent(this, "config-changed", { config: ev.detail.value });
  }

  private async _entitiesChanged(ev: CustomEvent): Promise<void> {
    const config = { ...this._config!, entities: ev.detail.value };
    if (
      config.entities?.some((statistic_id) =>
        isExternalStatistic(statistic_id)
      ) &&
      config.period === "5minute"
    ) {
      delete config.period;
    }
    const metadata =
      config.stat_types || config.unit
        ? await getStatisticMetadata(this.hass!, config.entities)
        : undefined;
    if (config.stat_types && config.entities.length) {
      config.stat_types = ensureArray(config.stat_types).filter((stat_type) =>
        metadata!.every((metaData) =>
          statisticsMetaHasType(metaData, statTypeMap[stat_type])
        )
      );
      if (!config.stat_types.length) {
        delete config.stat_types;
      }
    }
    if (
      config.unit &&
      !metadata!.some(
        (metaData) =>
          getDisplayUnit(this.hass!, metaData?.statistic_id, metaData) ===
          config.unit
      )
    ) {
      delete config.unit;
    }
    fireEvent(this, "config-changed", {
      config,
    });
  }

  private _computeLabelCallback = (schema) => {
    switch (schema.name) {
      case "chart_type":
      case "stat_types":
      case "period":
      case "unit":
        return this.hass!.localize(
          `ui.panel.lovelace.editor.card.statistics-graph.${schema.name}`
        );
      default:
        return this.hass!.localize(
          `ui.panel.lovelace.editor.card.generic.${schema.name}`
        );
    }
  };

  static styles: CSSResultGroup = css`
    ha-statistics-picker {
      width: 100%;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-statistics-graph-card-editor": HuiStatisticsGraphCardEditor;
  }
}
