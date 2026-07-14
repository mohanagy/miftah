/** The newest configuration format written by Miftah. */
export const CURRENT_CONFIG_VERSION = "2" as const;

/** Configuration formats accepted during the documented compatibility window. */
export const SUPPORTED_CONFIG_VERSIONS = ["1", CURRENT_CONFIG_VERSION] as const;

export type MiftahConfigVersion = (typeof SUPPORTED_CONFIG_VERSIONS)[number];
