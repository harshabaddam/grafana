import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { TestProvider } from 'test/helpers/TestProvider';

import { contextSrv, User } from 'app/core/services/context_srv';

import { OrgRole, Team } from '../../types';

import { Props, TeamList } from './TeamList';
import { getMockTeam, getMultipleMockTeams } from './__mocks__/teamMocks';

jest.mock('app/core/core', () => ({
  contextSrv: {
    hasPermission: (action: string) => true,
    licensedAccessControlEnabled: () => false,
  },
}));

const setup = (propOverrides?: object) => {
  const props: Props = {
    teams: [] as Team[],
    noTeams: false,
    loadTeams: jest.fn(),
    deleteTeam: jest.fn(),
    changePage: jest.fn(),
    changeQuery: jest.fn(),
    query: '',
    totalPages: 0,
    page: 0,
    hasFetched: false,
    editorsCanAdmin: false,
    perPage: 10,
    signedInUser: {
      id: 1,
      orgRole: OrgRole.Viewer,
    } as User,
  };

  Object.assign(props, propOverrides);

  contextSrv.user = props.signedInUser;

  render(
    <TestProvider>
      <TeamList {...props} />
    </TestProvider>
  );
};

describe('TeamList', () => {
  it('should render teams table', () => {
    setup({ teams: getMultipleMockTeams(5), teamsCount: 5, hasFetched: true });
    expect(screen.getAllByRole('row')).toHaveLength(6); // 5 teams plus table header row
  });

  describe('when user has access to create a team', () => {
    it('should enable the new team button', () => {
      jest.spyOn(contextSrv, 'hasPermission').mockReturnValue(true);
      setup({
        teams: getMultipleMockTeams(1),
        totalCount: 1,
        hasFetched: true,
        editorsCanAdmin: true,
        signedInUser: {
          id: 1,
          orgRole: OrgRole.Editor,
        } as User,
      });

      expect(screen.getByRole('link', { name: /new team/i })).not.toHaveStyle('pointer-events: none');
    });
  });

  describe('when user does not have access to create a team', () => {
    it('should disable the new team button', () => {
      jest.spyOn(contextSrv, 'hasPermission').mockReturnValue(false);
      setup({
        teams: getMultipleMockTeams(1),
        totalCount: 1,
        hasFetched: true,
        editorsCanAdmin: true,
        signedInUser: {
          id: 1,
          orgRole: OrgRole.Viewer,
        } as User,
      });

      expect(screen.getByRole('link', { name: /new team/i })).toHaveStyle('pointer-events: none');
    });
  });
});

it('should call delete team', async () => {
  const mockDelete = jest.fn();
  const mockTeam = getMockTeam();
  jest.spyOn(contextSrv, 'hasAccessInMetadata').mockReturnValue(true);
  setup({ deleteTeam: mockDelete, teams: [mockTeam], totalCount: 1, hasFetched: true });
  await userEvent.click(screen.getByRole('button', { name: `Delete team ${mockTeam.name}` }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => {
    expect(mockDelete).toHaveBeenCalledWith(mockTeam.id);
  });
});
